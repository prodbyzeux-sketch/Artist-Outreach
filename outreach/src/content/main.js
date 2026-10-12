// main.js — the entry point: one route to the lead, then the chosen path.
//
// The background worker talks to this file:
//   { type: "PING" }                              -> { ok, url }
//   { type: "SEND", payload: { username, message, settings } }
//        -> { status: "sent" | "skipped" | "failed" | "blocked", reason?, error? }
//        -> { status: "notInSearch" }  Direct's search doesn't know them; the
//           worker opens their profile by address and asks again with
//           settings.viaProfile, which takes the other way in.
//
// And back the other way, because the worker is the one that sees the network:
//   { type: "CONVERSATION", username }  -> { known, exists, messages }
//   { type: "CONTENT_READY", url }      -> the page reloaded under a lead
//
// Loads last — see the header of dom.js for the file order and why it matters.

(() => {
  "use strict";
  const S = globalThis.__igs;
  const {
    sleep, rand, handle, humanPause, step, waitFor,
    realClick, dismissNagModals, detectRefusal, recoverPageError, pageWasBroken, submitsMade,
    probeExistingMessages, probeReachability, findThreadProfileLink, currentThreadId,
    waitForProfileCounts, describeMissingCounts,
    goToDirect, openLeadThread, onLeadProfile, openThreadFromProfile, leadThreadIsOpen,
    runJustDM, runReplyToPost, runReplyToStory,
  } = S;

  // Every lead is reached through Direct's search — back to Direct, search them
  // by handle, open the conversation — and only then does the chosen path branch
  // off. That one route does three jobs: it never types a profile URL, it proves
  // the lead is reachable, and because the thread is open for EVERY path it makes
  // "skip existing conversation" apply everywhere instead of to plain DMs alone.
  //
  // There is exactly one other way in, and only after search has genuinely given
  // up: their profile, opened by address, and its Message button. Both routes end
  // in the same place — an open thread — so everything after them is shared.
  //
  // The typing rhythm itself lives in the worker's human profile; `speed` is
  // just the user's multiplier from Settings (>1 = faster).
  // Set while standing in the lead's conversation, read by send() once the path
  // has finished somewhere else entirely.
  let threadId = null;

  // The ordinary way in: back to Direct, search, open the conversation. Returns
  // null once the thread is open, else the result the lead ends on.
  async function reachViaSearch(username, speed) {
    if (!(await goToDirect())) return { status: "failed", error: "could not open Direct" };
    const problem = await openLeadThread(username, speed);
    // Not a skip on its own any more: Instagram's search misses accounts that do
    // exist, so the worker gets one more thing to try — their profile, by
    // address — and only what it finds THERE decides the lead.
    if (problem === "notFound") return { status: "notInSearch" };
    if (problem) return { status: "failed", error: problem };
    return null;
  }

  // The way in when search couldn't find them: the worker has opened their
  // profile by address, and the Message button leads from there into the thread.
  const UNREACHABLE = {
    notFound: (u) => `@${u} doesn't exist any more`,
    privateLocked: (u) => `@${u} is private and takes no messages`,
    noMessageEntry: (u) => `no way to message @${u} from their profile`,
  };

  async function reachViaProfile(username) {
    if (leadThreadIsOpen(username)) return null;      // a second attempt, already inside
    if (!(await recoverPageError())) return { status: "failed", error: "Instagram won't load their profile" };
    if (!onLeadProfile(username)) {
      return { status: "failed", error: `their profile didn't open (${location.pathname})` };
    }
    const reach = probeReachability();
    if (reach !== "reachable") return { status: "skipped", reason: UNREACHABLE[reach](handle(username)) };
    await humanPause(800, 1600);
    if (!(await openThreadFromProfile(username))) {
      return { status: "failed", error: "their Message button didn't open a conversation" };
    }
    return null;
  }

  // What Instagram answered when this thread opened, if the worker caught it.
  async function askInstagram(username) {
    try {
      return await chrome.runtime.sendMessage({ type: "CONVERSATION", username: handle(username) })
        || { known: false };
    } catch (_e) {
      return { known: false };   // worker asleep or the port died — read the screen instead
    }
  }

  // Whether this lead has been written to before — read in the open thread, so
  // it holds whichever way the thread was reached.
  //
  // Instagram answers this itself: opening a chat fetches that thread, and the
  // payload says whether it exists and how much is in it. That beats measuring
  // bubbles, which has twice skipped leads over a thread with nothing in it.
  // The screen is still read when the answer never came — re-opening a thread
  // the page already showed fetches nothing at all.
  async function skipIfExisting(username, settings) {
    if (!settings.skipExisting) return null;
    await sleep(rand(800, 1400));

    const said = await askInstagram(username);
    if (said.known) {
      // The count is what the payload carried, not the length of the thread —
      // the inbox sends the last few messages per conversation, not all of them.
      step("existing-conversation check: Instagram's own thread data — "
        + (said.messages == null ? "the thread exists" : `${said.messages} message(s) in it`));
      return said.exists ? { status: "skipped", reason: "existing conversation" } : null;
    }

    const probe = await probeExistingMessages();
    // Logged whichever way it goes: this check silently skipped every lead once,
    // and the only reason that was invisible is that nothing said what the probe
    // had actually seen.
    step(`existing-conversation check (from the screen): ${probe.debug}`
      + (probe.confident ? "" : " — not readable, sending anyway"));
    return probe.confident && probe.any ? { status: "skipped", reason: "existing conversation" } : null;
  }

  async function runSend(payload) {
    const { username, message, settings } = payload;
    const speed = settings.typingSpeed || 1;
    threadId = null;

    // A block modal from the previous lead is still standing here — it would
    // swallow every click that follows, so say so before touching anything.
    const standingBlock = detectRefusal();
    if (standingBlock && standingBlock.blocked) return { status: "blocked", error: standingBlock.text };

    await dismissNagModals();
    if (!(await recoverPageError())) return { status: "failed", error: "Instagram won't load the page" };
    await humanPause(600, 1300);

    // Where the page ALREADY stands counts. Instagram's reload tears this script
    // down mid-lead and the worker asks again — with the browser sitting exactly
    // where the last attempt left it, on the lead's profile or even in their
    // thread. Walking back through Direct's search from there costs a minute and
    // arrives at the same page; observed as the same lead searched, opened and
    // walked to a profile three times over, once per reload.
    //
    // A profile format standing ON the profile needs nothing else: the posts and
    // the story ring are on this page. Opening the conversation first would only
    // serve the existing-check, and it costs two more client-side navigations —
    // the very ones Instagram keeps failing. So say what is being given up and
    // reply from here.
    const wantsProfile = settings.format === "replyToPost" || settings.format === "replyToStory";
    if (wantsProfile && onLeadProfile(username) && !leadThreadIsOpen(username)) {
      step("already standing on their profile — replying from here"
        + (settings.skipExisting ? " (no thread open, so no existing-conversation check)" : ""));
      if (!(await recoverPageError())) {
        return { status: "failed", error: "Instagram won't load their profile" };
      }
      await humanPause(800, 1600);
      // This branch returns without ever opening the conversation, so the filter
      // has to be asked here too — and the numbers it wants are on the very page
      // we are standing on.
      if (settings.audienceFilter) {
        const turnedAway = await checkAudience();
        if (turnedAway) return turnedAway;
      }
      return settings.format === "replyToPost"
        ? runReplyToPost({ username, message, settings, speed })
        : runReplyToStory({ username, message, settings, speed });
    }

    const standing = settings.viaProfile || leadThreadIsOpen(username) || onLeadProfile(username);
    let unreached = standing
      ? await reachViaProfile(username)
      : await reachViaSearch(username, speed);
    // Being on their profile is a dead end only when the worker deliberately put
    // us there. Standing on it by accident and failing just means the ordinary
    // way in hasn't been tried yet.
    if (unreached && standing && !settings.viaProfile) {
      step(`${unreached.error || unreached.reason} — going in through Direct instead`);
      unreached = await reachViaSearch(username, speed);
    }
    if (unreached) return unreached;
    threadId = currentThreadId();
    step(`opened the conversation with @${handle(username)}`);

    const existing = await skipIfExisting(username, settings);
    if (existing) return existing;

    // settings.format is chosen per lead by the background worker, which also
    // resolves the audience filter down to this one flag (audienceFilterOn in
    // src/audience.js) — a filter with no bound set never gets this far.
    //
    // Both reasons lead to the same place. The reply paths need the profile to
    // find a post or a story; the filter needs it for the two numbers written on
    // it. So a filtered plain DM takes the profile route too, and pays for it
    // with the walk rather than with a request nobody's browser would make.
    if (!wantsProfile && !settings.audienceFilter) {
      return runJustDM({ username, message, settings, speed });
    }
    // Let the thread finish arriving first. Instagram fails its own client-side
    // navigations often enough on this step ("Something went wrong" on a profile
    // that opens fine by hand) that leaving its requests in flight is not worth
    // the second it saves.
    await humanPause(1200, 2400);
    step("opening the profile from the conversation");
    // Re-resolve the link at click time, and give it a second go: the header
    // re-renders while the thread's messages stream in, so a node picked up
    // before that re-render is detached and the click lands nowhere at all —
    // the same lesson the share sheet's rows taught.
    const profilePath = new RegExp(`^/${handle(username)}/?$`);
    for (let attempt = 0; attempt < 2 && !profilePath.test(location.pathname); attempt++) {
      const link = await waitFor(() => findThreadProfileLink(username), 6000);
      if (!link) return { status: "failed", error: "no profile link in the conversation header" };
      try {
        await realClick(link);
      } catch (e) {
        if (attempt) throw e;
        step(`the header link moved under the cursor (${e.message}) — trying once more`);
      }
      await waitFor(() => (profilePath.test(location.pathname) ? true : null), 6000);
    }
    if (!profilePath.test(location.pathname)) {
      return { status: "failed", error: "the profile didn't open from the conversation" };
    }
    // Their profile can come up as Instagram's error page, and an empty page
    // reads as "no posts, no stories" — the run would drop to a plain DM and
    // blame the lead for it. Give it its reload before judging what is there —
    // but LOOK only after a pause: the error screen lands a second or two after
    // the navigation, so checking the instant the URL changes sees a page that is
    // merely still loading and lets it through. (The paths themselves check
    // again, right where they would otherwise conclude the profile is empty.)
    await humanPause(800, 1600);
    if (!(await recoverPageError())) {
      return { status: "failed", error: "Instagram won't load their profile" };
    }

    if (settings.audienceFilter) {
      const turnedAway = await checkAudience();
      if (turnedAway) return turnedAway;
    }

    if (!wantsProfile) {
      // The filter is the only reason this lead is standing on a profile, and a
      // plain DM goes back into the conversation the way a person does from
      // here: the Message button, which opens the chat over the profile.
      const unreachable = await reachViaProfile(username);
      if (unreachable) return unreachable;
      return runJustDM({ username, message, settings, speed });
    }

    return settings.format === "replyToPost"
      ? runReplyToPost({ username, message, settings, speed })
      : runReplyToStory({ username, message, settings, speed });
  }

  // The filter's verdict, asked for while standing on the lead's profile. The
  // numbers are read off the page here; the rule that judges them lives in
  // src/audience.js, and these files are classic scripts that cannot import it —
  // so the worker is asked, and there is one copy of the rule instead of two.
  //
  // The round-trip itself gets two goes, and never fails without saying why.
  // This is the one message sent after a lead's quietest stretch — the walk from
  // the thread to the profile — which is where Chrome is free to throw the
  // worker away, and a message is what wakes the next one. "Nobody answered" is
  // the wrong kind of unarguable: what came back has to name itself.
  async function checkAudience() {
    const bothRead = (c) => Number.isFinite(c.followers) && Number.isFinite(c.posts);
    let counts = await waitForProfileCounts();
    // A profile with no numbers on it and Instagram's error screen look the same
    // from here, and that screen does NOT arrive with the navigation — it lands a
    // second or two later, after the check made on the way in. So the rule the
    // post and story paths already follow: where an empty conclusion is drawn,
    // ask whether the page was broken, and look again once it has been reloaded.
    if (!bothRead(counts) && await pageWasBroken()) counts = await waitForProfileCounts();
    // The rule for "unreadable" lives in src/audience.js and answers below; this
    // only puts the page's own state in the log while it is still there to look at.
    if (!bothRead(counts)) step(describeMissingCounts());
    let answer = null;
    let why = "the worker answered with nothing";
    for (let attempt = 0; attempt < 2 && !answer; attempt++) {
      if (attempt) {
        step(`the audience check went unanswered (${why}) — asking once more`);
        await humanPause(400, 800);
      }
      answer = await chrome.runtime.sendMessage({ type: "AUDIENCE", ...counts })
        .catch((e) => { why = String((e && e.message) || e); return null; });
    }
    if (!answer) return { status: "failed", error: `the audience check went unanswered: ${why}` };
    if (answer.error) return { status: "failed", error: answer.error };
    step(`audience check: ${answer.seen}`);
    return answer.pass ? null : { status: "skipped", reason: answer.reason };
  }

  // A lead that failed on the way in gets another go HERE, in the same visit —
  // not by going back in the queue, which would leave it for the end of the run
  // and lose everything the last attempt learned. Nothing about the page is
  // trusted between attempts: each one starts over from Direct.
  //
  // The one thing that must never be repeated is a message. submitsMade() moving
  // is the point of no return: past it the message may well have gone out, and
  // a "failed" that reads like a lost click could quietly deliver it twice.
  const LEAD_ATTEMPTS = 2;

  // Whatever happened, end standing in Direct so the next lead starts from a
  // known place — a failure deep in a share sheet must not strand the run.
  //
  // The thread id is read while we are still IN the conversation — the reply
  // paths walk off to the profile and a story viewer afterwards — and carried
  // out with the result, because this is the only moment it exists.
  async function send(payload) {
    try {
      let result = null;
      for (let attempt = 1; attempt <= LEAD_ATTEMPTS; attempt++) {
        if (attempt > 1) {
          step(`${result.error} — starting this lead over (${attempt}/${LEAD_ATTEMPTS})`);
          await humanPause(1500, 3000);
        }
        const submitted = submitsMade();
        result = await runSend(payload)
          .catch((e) => ({ status: "failed", error: String((e && e.message) || e) }));
        // Abandoned means nobody is waiting for this lead any more — say so
        // plainly rather than reporting whatever step happened to notice first,
        // and do not start it over.
        if (S.sendWasAbandoned()) {
          result = { status: "failed", error: "the lead was abandoned — the worker moved on" };
          break;
        }
        if (result.status !== "failed" || submitsMade() !== submitted) break;
      }
      return threadId && result.status === "sent" ? { ...result, threadId } : result;
    } finally {
      await goToDirect().catch(() => {});
    }
  }

  // ── who is sending ────────────────────────────────────────────────────────────
  // The one place this extension asks Instagram for something instead of
  // watching what it already fetched. It is a single call about OUR OWN account,
  // once per run, to the same endpoint the settings page uses — not the repeated
  // traffic that reading the inbox would have meant. Ported from Tabels, which
  // takes this route specifically to avoid navigating away from the run.
  //
  // Nothing about a LEAD is ever asked for this way. Their follower and post
  // counts are read off their profile instead (readProfileCounts in finders.js):
  // measured on live Instagram, the web app itself never calls this endpoint
  // while a person browses, so calling it about each lead would be traffic no
  // ordinary browsing produces.
  const IG_APP_ID = "936619743392459";

  async function readOwnProfile() {
    const out = { username: "", fullName: "", bio: "", avatar: "", readAt: Date.now() };
    try {
      const r = await fetch("/api/v1/accounts/edit/web_form_data/", {
        headers: { "x-ig-app-id": IG_APP_ID, "x-requested-with": "XMLHttpRequest" },
        credentials: "include",
      });
      if (r.ok) {
        const j = await r.json();
        const f = (j && (j.form_data || j.data)) || {};
        out.username = f.username || "";
        out.bio = f.biography || "";
        out.fullName = f.first_name || f.full_name || "";
        out.avatar = f.profile_pic_url || "";
      }
    } catch (_e) { /* not signed in, or IG moved the endpoint — fall through */ }

    // The public profile carries the better avatar and the full name.
    if (out.username) {
      try {
        const r = await fetch(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(out.username)}`,
          { headers: { "x-ig-app-id": IG_APP_ID }, credentials: "include" });
        const u = r.ok ? (await r.json())?.data?.user : null;
        if (u) {
          out.bio = u.biography || out.bio;
          out.fullName = u.full_name || out.fullName;
          out.avatar = u.profile_pic_url_hd || u.profile_pic_url || out.avatar;
          out.followers = u.edge_followed_by?.count ?? undefined;
          out.posts = u.edge_owner_to_timeline_media?.count ?? undefined;
        }
      } catch (_e) { /* the first call already gave us enough */ }
    }
    return out.username ? out : null;
  }

  Object.assign(S, { readOwnProfile });

  // The one send this tab is allowed to be running, so a repeated SEND joins it
  // rather than racing it into the same field.
  let inFlight = null;

  // Two SENDs, two meanings. The same lead again is the worker asking for an
  // answer it thinks it lost — join the run already going, never start a second
  // one into the same composer. A DIFFERENT lead means the worker has given up
  // on the one in flight (its own timeout, too many reloads under it) and moved
  // on; refusing it was worse than useless — the new lead came back "busy
  // sending to @someone", and three of those in a row stop the whole run. So the
  // old send is abandoned, waited out, and the new lead gets the page.
  async function handleSend(payload) {
    if (inFlight && inFlight.username !== handle(payload.username)) {
      step(`the worker moved on to @${handle(payload.username)} — dropping the send to @${inFlight.username}`);
      S.abandonSend();
      await inFlight.run.catch(() => {});
      S.resumeSends();
    }
    if (inFlight) {
      step("a send for this lead is already running — waiting for it instead of starting another");
      return inFlight.run;
    }
    const run = send(payload);
    inFlight = { username: handle(payload.username), run };
    // Only ever clears ITS OWN entry: by the time an abandoned send settles, the
    // lead that displaced it may already be the one in flight.
    run.catch(() => {}).then(() => { if (inFlight && inFlight.run === run) inFlight = null; });
    return run;
  }

  // The worker re-injects the whole set when a page stops answering, so this can
  // run twice on one page. A second listener would answer the same message
  // twice; the finders in the other files are pure and harmless to redefine.
  if (globalThis.__igsListening) return;
  globalThis.__igsListening = true;

  // Say hello. A reload — Instagram's own, or the one we press on its error
  // screen — brings this layer back as a blank slate: the hands are gone from
  // the screen and the worker is still waiting on an answer nobody will send.
  // This is how it finds out the page underneath it changed.
  chrome.runtime.sendMessage({ type: "CONTENT_READY", url: location.href }).catch(() => {});

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (!msg || !msg.type) return false;
    // The viewport goes in the reply because Instagram's layout hangs on it —
    // Direct collapses when it's narrow, the story viewer reflows when it's
    // short — and the work window's real size is the browser's outer size
    // minus whatever chrome and the debugging bar take.
    if (msg.type === "PING") {
      respond({ ok: true, url: location.href, w: innerWidth, h: innerHeight });
      return false;
    }
    // A deliberate pass over the conversation list at run start, so Instagram
    // fetches enough threads for the dashboard to see who answered.
    if (msg.type === "SCAN_INBOX") {
      S.scanInbox(msg.passes)
        .then((problem) => respond({ ok: !problem, error: problem || undefined }))
        .catch((e) => respond({ ok: false, error: String((e && e.message) || e) }));
      return true;
    }
    if (msg.type === "HANDS") {
      S.hands.show(msg.on, msg.skin);
      respond({ ok: true });
      return false;
    }
    // Load something the worker wants the bytes of. It reads them off the wire
    // itself (armCapture in src/cdp.js) — all that is needed from here is
    // the request, made from the page, where Instagram's CDN sees Instagram
    // asking. no-cors because we are not allowed to read the answer and do not
    // need to; reload because a memory-cache hit is not a response anybody can
    // read the bytes of.
    // arrayBuffer() drains a response this page is not allowed to look inside:
    // it comes back empty — opaque is opaque — but not until the whole picture
    // has arrived, which is what makes this answer worth anything. The bytes go
    // to the worker another way entirely (armCapture in src/cdp.js), off the
    // wire, before the page is handed anything. Both measured in
    // test/avatar-capture.test.mjs.
    if (msg.type === "PULL") {
      fetch(msg.url, { mode: "no-cors", cache: "reload", credentials: "include" })
        .then((r) => r.arrayBuffer())
        .then(() => respond({ ok: true }))
        .catch((e) => respond({ ok: false, error: String((e && e.message) || e) }));
      return true;
    }
    if (msg.type === "OWN_PROFILE") {
      readOwnProfile().then((p) => respond({ ok: !!p, profile: p })).catch(() => respond({ ok: false }));
      return true;
    }
    if (msg.type === "SEND") {
      handleSend(msg.payload)
        .then(respond)
        .catch((e) => respond({ status: "failed", error: String((e && e.message) || e) }));
      return true; // async
    }
    // The worker has stopped waiting for the send in flight — stop driving the
    // page for it rather than clicking on through the pause before the next lead.
    if (msg.type === "ABANDON") {
      if (inFlight) {
        step(`nobody is waiting for the send to @${inFlight.username} any more — stopping it`);
        S.abandonSend();
        inFlight.run.catch(() => {}).then(() => S.resumeSends());
      }
      respond({ ok: true });
      return false;
    }
    return false;
  });
})();
