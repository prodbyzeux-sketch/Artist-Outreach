// direct.js — Direct: the way in to every lead, and the plain-DM send.
//
// Leads are reached through Instagram's own search, not by typing a profile
// URL. Verified against the live UI: the paper-plane is an <a> pointing at
// /direct/, the inbox carries one "Search" input, and each result is a
// div[role="button"][tabindex="0"] about 72px tall holding an avatar plus the
// display name AND the exact @handle as separate text leaves — the same shape
// as the share sheet's rows, so the same exact-handle matching applies.

(() => {
  "use strict";
  const S = globalThis.__igs;
  const {
    sleep, rand, handle, humanPause, step, isVisible, waitFor,
    input, pressEnter, pressEscape, realClick, dismissNagModals, fillField, typeAndSubmit,
    pageWasBroken, pageFailedToLoad, sendWasAbandoned,
    findComposer, threadIsOpen, isSearchField, rowHandles, findMessageButton, findLeadChatBox,
  } = S;

  const findDirectSearch = () =>
    [...document.querySelectorAll("input")].filter(isVisible).find(isSearchField) || null;

  // "In Direct" means the search box is reachable — NOT that we're on
  // /direct/inbox/. The paper-plane's href follows the last conversation you
  // opened (observed: /direct/t/17848…), so clicking it usually lands in a
  // thread, and the search column is right there either way.
  const directIsOpen = () => /\/direct\//.test(location.pathname) && !!findDirectSearch();

  const findDirectLink = () => {
    const links = [...document.querySelectorAll('a[href*="/direct/"]')].filter(isVisible);
    return links.find((a) => a.querySelector("svg")) || links[0] || null;
  };

  // Direct's results arrive in two sections: message hits first, accounts
  // after. A message row matches the handle just as well as an account row
  // does — the query is highlighted as its own text leaf inside the preview —
  // and since our own messages carry the lead's @handle, EVERY send breeds
  // another false row. That is why this route worked for the first couple of
  // leads and then stopped.
  //
  // Verified live: clicking a message row doesn't open the conversation at
  // all. It drills into a message-search sub-view (taking the search box with
  // it), which is exactly the "the conversation didn't open" failure.
  //
  // Two message shapes, both observed, neither of which an account row has:
  //   ["pjxproduction", "ayosavvage", "·", "10w"]   a preview with a timestamp
  //   ["ayosavvage", "2 matched messages"]          a thread's match count
  // Account rows read ["ayosavvage"] or ["producer🎶", "ayosavvage4x", "<bio>"].
  const isMessageRow = (leaves, uLow) =>
    leaves.includes("·") ||
    (leaves.length <= 2 && leaves.some((t) => t !== uLow && /^\d/.test(t)));

  // Never "the first row" on its own: IG's ranking is not about the query —
  // searching "ayosavvage" put a completely different account in row one.
  //
  // The survivors are taken LAST-first. Messages are always listed above the
  // accounts, so if the shape test above ever misses a message row, the miss
  // still sorts before the real account and the last survivor is the safe one.
  function searchResultRows(username) {
    const uLow = handle(username);
    if (!uLow) return [];
    return [...document.querySelectorAll('div[role="button"][tabindex="0"]')]
      .filter(isVisible)
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 200 && r.height > 40 && r.height < 110 && !!el.querySelector("img");
      })
      .filter((row) => {
        const leaves = rowHandles(row);
        return leaves.includes(uLow) && !isMessageRow(leaves, uLow);
      });
  }

  const findSearchResultRow = (username) => {
    const rows = searchResultRows(username);
    return rows[rows.length - 1] || null;
  };

  // The lead's profile link in the open thread's header — the route from a
  // conversation to their posts and stories.
  function findThreadProfileLink(username) {
    const uLow = handle(username);
    return [...document.querySelectorAll('a[href^="/"]')].filter(isVisible).find((a) => {
      const r = a.getBoundingClientRect();
      return r.top >= 0 && r.top < 120 && r.height > 20 && r.width > 40 &&
        handle((a.getAttribute("href") || "").replace(/\//g, "")) === uLow;
    }) || null;
  }

  // "A conversation is open" is never enough: the previous lead's thread is
  // still standing when we arrive, so waiting on that alone would report
  // success before the click even landed — and then probe the wrong history.
  // The header's profile link is what says WHOSE conversation this is.
  //
  // …and it does not have to be a page at all: Instagram's Message button opens
  // an inline chat over the profile, same conversation, no navigation.
  const leadThreadIsOpen = (username) =>
    (threadIsOpen() && !!findThreadProfileLink(username)) || !!findLeadChatBox(username);

  // Instagram's own routes read exactly like a handle — /reels/ is a link to a
  // person as far as a pattern is concerned. findThreadProfileLink is safe from
  // them because it is told which handle to look for; this one is not, so it
  // says out loud what is not a person.
  const NOT_A_HANDLE = /^(explore|reels|direct|accounts|stories|p|tv|channel|your_activity|about|legal|privacy|terms)$/i;

  // Whose conversation is open, read off the same header link as
  // findThreadProfileLink — without being told whose it should be.
  const threadOwner = () => {
    const link = [...document.querySelectorAll('a[href^="/"]')].filter(isVisible).find((a) => {
      if (a.closest('nav, [role="navigation"]')) return false;
      const name = handle((a.getAttribute("href") || "").replace(/\//g, ""));
      if (!/^[a-z0-9._]+$/.test(name) || NOT_A_HANDLE.test(name)) return false;
      const r = a.getBoundingClientRect();
      return r.top >= 0 && r.top < 120 && r.height > 20 && r.width > 40;
    });
    return link ? handle((link.getAttribute("href") || "").replace(/\//g, "")) : null;
  };

  // What the page actually was when the thread should have been open. "It didn't
  // open" cannot tell a click that went nowhere from a thread that opened for
  // somebody else from a page Instagram replaced with its own error — and every
  // one of those is a different fix, so the log has to carry the difference.
  const describeThreadState = (username) => {
    const owner = threadOwner();
    return [
      location.pathname,
      threadIsOpen() ? "a thread is open" : "no composer on the page",
      owner ? `the header points at @${owner}` : "nothing in the header",
      findLeadChatBox(username) ? "an inline chat is up" : null,
      pageFailedToLoad() ? "Instagram's own error screen is up" : null,
    ].filter(Boolean).join(" · ");
  };

  // ── the way in when search can't find them ───────────────────────────────────
  // Standing on the lead's own profile, by address. The run reaches everybody
  // through Direct's search on purpose — but that search does not always find an
  // account that exists (a handle it is still indexing, a throttled search), and
  // writing the lead off for it is worse than one navigation. The worker opens
  // the profile; this is the door from there into the conversation.
  const onLeadProfile = (username) => new RegExp(`^/${handle(username)}/?$`).test(location.pathname);

  // Twice: a profile that has only just loaded re-renders its header once the
  // rest arrives, and the click then lands on a button that no longer exists.
  async function openThreadFromProfile(username) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const btn = await waitFor(findMessageButton, 6000);
      if (!btn) return false;
      step("opening the conversation with their Message button");
      try {
        await realClick(btn);
      } catch (e) {
        step(`the Message button wouldn't take a click (${e.message})`);
        return false;
      }
      if (await waitFor(() => (leadThreadIsOpen(username) ? true : null), 9000)) return true;
      // Landing in Direct without their thread means the click went to the
      // navigation, not to their button — worth saying, because from here the
      // run looks like it simply wandered off to the inbox.
      if (/\/direct\//.test(location.pathname)) {
        step("that click went to the inbox, not their conversation");
        return false;
      }
      if (!onLeadProfile(username)) return false;
    }
    return false;
  }

  // The conversation's own id, straight out of /direct/t/<id>/. Worth grabbing
  // while we are standing in the thread: it is what ties a lead to the inbox
  // later, and re-deriving it from the handle is the same fragile matching that
  // the search rows already taught us to avoid.
  const currentThreadId = () => {
    const m = location.pathname.match(/\/direct\/t\/([^/]+)/);
    return m ? m[1] : null;
  };

  // Whatever surface the last step left open — a post modal, a share sheet, a
  // story — back out of it before navigating.
  async function closeOverlays() {
    for (let i = 0; i < 3; i++) {
      if (!document.querySelector('div[role="dialog"]') && !/\/stories\//.test(location.pathname)) break;
      await pressEscape();
      await sleep(rand(400, 800));
    }
    await dismissNagModals();
  }

  // Back to Direct the way a person does — the paper-plane, never a typed URL.
  //
  // Twice, because one miss here costs a lead that had nothing wrong with it:
  // the paper-plane is not on the page yet while a story viewer is closing or a
  // profile is still coming up, and a click at a link that moves lands nowhere.
  async function goToDirect() {
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (sendWasAbandoned()) return false;   // nobody is waiting for this lead
      await closeOverlays();
      if (directIsOpen()) return true;
      // No paper-plane can also mean Instagram broke the page under us between
      // leads — its error screen leaves nothing behind it to click.
      let plane = await waitFor(findDirectLink, 4000);
      if (!plane && await pageWasBroken()) plane = await waitFor(findDirectLink, 6000);
      if (plane) {
        try {
          await realClick(plane);
          if (await waitFor(() => (directIsOpen() ? true : null), 9000)) return true;
        } catch (e) {
          step(`couldn't reach Direct (${e.message})`);
        }
      }
      await humanPause(800, 1600);
    }
    return false;
  }

  // One pass at the search box: type the handle, wait for the lead's row, open
  // the conversation. Returns null on success, else a short reason.
  async function searchForLead(username, speed) {
    if (!(await waitFor(findDirectSearch, 8000))) return "no search field in Direct";
    // The previous lead's query is still in there, so this clears before typing —
    // and reads the box back afterwards, because a query that lands half-typed
    // finds nothing and the lead is written off as missing.
    const typed = await fillField(findDirectSearch, handle(username), speed);
    if (typed) return typed;

    if (!(await waitFor(() => findSearchResultRow(username), 8000))) return "notFound";
    await humanPause(700, 1400);            // let the result list settle
    const row = findSearchResultRow(username);
    if (!row) return "notFound";
    // Name the pick: when a click lands in message search instead of the
    // conversation, this is the only line that says which row did it.
    step(`picking result row [${rowHandles(row).join(" | ")}]`);
    try {
      await realClick(row);
    } catch (e) {
      return `couldn't click the result row (${e.message})`;
    }
    const opened = () => (leadThreadIsOpen(username) ? true : null);
    if (await waitFor(opened, 9000)) return null;
    // The same rule the profile reads follow: Instagram's error screen lands a
    // second or two after the click, i.e. AFTER every check made on the way in,
    // so the negative conclusion is the place to ask. A page that was broken has
    // been reloaded by the time this answers, and deserves the second look.
    if (await pageWasBroken() && await waitFor(opened, 9000)) return null;

    // A row matches on ANY of its text leaves, and one of those is the account's
    // NAME. Measured live: searching "dezmadeit" returns a single row — an
    // account named dezmadeit whose handle is @dezollynbeats — and clicking it
    // opens a real conversation with the wrong person. Searching again cannot
    // help: the same row wins every time. And it is not a lead worth failing,
    // because what it means is that Direct's search has no such account — which
    // is precisely `notFound`, and the worker answers that by going in through
    // the profile URL instead.
    const owner = threadOwner();
    if (threadIsOpen() && owner && owner !== handle(username)) {
      step(`that row opened @${owner}'s conversation, not @${handle(username)}'s — Direct's search has no such account`);
      return "notFound";
    }
    return `the conversation didn't open (${describeThreadState(username)})`;
  }

  // Getting to a lead is the one part of a lead that is safe to repeat: nothing
  // has been said to anybody yet, and re-searching costs seconds. It is also the
  // flakiest part — Instagram's result list arrives late or not at all, a row
  // opens message search instead of the conversation, the page throws its own
  // error over the top — and every one of those used to cost the lead outright,
  // written off as "not found in Direct" or counted towards the three
  // consecutive failures that stop a run. Each attempt starts from Direct again.
  const SEARCH_ATTEMPTS = 3;

  async function openLeadThread(username, speed) {
    let problem = null;
    for (let attempt = 1; attempt <= SEARCH_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        step(`${problem} — searching again (${attempt}/${SEARCH_ATTEMPTS})`);
        await humanPause(1200, 2600);
        if (!(await goToDirect())) return "could not get back to Direct";
      }
      problem = await searchForLead(username, speed);
      if (!problem) return null;
    }
    return problem;
  }

  // Page through the conversation list so Instagram fetches the next batch of
  // threads. We never request anything ourselves — this just makes the page ask
  // for what it would ask for if a person were scrolling, and the worker records
  // the replies out of those responses (src/inbox.js).
  async function scanInbox(passes = 4) {
    if (!(await goToDirect())) return "could not open Direct";
    const list = [...document.querySelectorAll("div, section")].filter(isVisible).filter((el) => {
      const r = el.getBoundingClientRect();
      const oy = getComputedStyle(el).overflowY;
      return /auto|scroll/.test(oy) && el.scrollHeight > el.clientHeight + 50 && r.left < 520 && r.width > 200;
    }).sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    if (!list) return "no conversation list to scroll";

    const box = list.getBoundingClientRect();
    await input("move", { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) });
    for (let i = 0; i < passes; i++) {
      await input("wheel", { dy: Math.round(rand(500, 900)) });
      await humanPause(900, 1800);        // let the next page actually arrive
    }
    for (let i = 0; i < passes; i++) {    // back to the top, where a person leaves it
      await input("wheel", { dy: -Math.round(rand(600, 1000)) });
      await sleep(rand(150, 350));
    }
    return null;
  }

  // ── FLOW A — just DM ────────────────────────────────────────────────────────
  // Normally the thread is already open: main.js got here through Direct search,
  // which is also where the existing-conversation check ran. The reply paths
  // fall back here from the profile, so re-open the thread when that happens.
  async function runJustDM({ username, message, settings, speed }) {
    // Standing on their profile — a reply path that gave up, or a lead reached by
    // address because search couldn't find them — the Message button is right
    // there, and for the second of those it is the only door that works.
    if (!leadThreadIsOpen(username) && onLeadProfile(username)) {
      await openThreadFromProfile(username);
    }
    if (!leadThreadIsOpen(username)) {
      if (!(await goToDirect())) return { status: "failed", error: "could not get back to Direct" };
      const problem = await openLeadThread(username, speed);
      if (problem === "notFound") return { status: "skipped", reason: `@${handle(username)} not found in Direct` };
      if (problem) return { status: "failed", error: problem };
    }
    if (!(await waitFor(findComposer, 6000))) return { status: "failed", error: "DM composer not found" };
    // This surface has no Send button at all — Enter is the only submit.
    return typeAndSubmit(findComposer, message, speed, { submit: pressEnter });
  }

  Object.assign(S, {
    findDirectSearch, directIsOpen, findDirectLink, findSearchResultRow,
    findThreadProfileLink, leadThreadIsOpen, threadOwner, describeThreadState, currentThreadId,
    onLeadProfile, openThreadFromProfile,
    closeOverlays, goToDirect, openLeadThread, scanInbox, runJustDM,
  });
})();
