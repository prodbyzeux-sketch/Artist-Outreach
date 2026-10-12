// background.js — service worker orchestrating the send run, and the only place
// that touches the mouse and keyboard.
//
// Each run opens a dedicated Instagram window and attaches chrome.debugger to
// it, so every click and keystroke is real, trusted browser input driven by a
// human profile (src/cdp.js + src/human.js). The content layer (src/content/*)
// decides WHAT to touch and sends the coordinates here. Nothing navigates
// between leads: the window lands in Direct once and the content script walks
// to each lead through Instagram's own search — the sole exception being a lead
// that search cannot find, whose profile is then opened by address. Per lead we personalize the
// message (spintax + table variables) and ask it to run the chosen send path.
// Stop is immediate — it closes the window, aborting whatever is in progress,
// and losing the debugger mid-run stops the whole run the same way.

import {
  KEYS, STATUS, get, set, getTables, getSettings, getMessages, getFollowups, getLeads,
  getRunState, setRunState, updateLead, enabledFormats, getHumanSeed, getInbox, setInbox, setProfile,
  handSkin,
} from "./storage.js";
import { applySpintax, personalize, mergedLookup } from "./spintax.js";
import { parseInboxBodies, mergeFacts, blockSignal, readConversations } from "./inbox.js";
import { nextJob, dueFollowups, FOLLOWUP_PACE } from "./followups.js";
import { audienceFilterOn, audienceVerdict, unreadableCounts, formatCount } from "./audience.js";
import * as cdp from "./cdp.js";
// Artist Outreach decides whether this account may send, and how much today.
import { checkRunAllowed, claimDm, releaseDm, describeQuota } from "../../platform/quota.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

// ── in-memory run state ───────────────────────────────────────────────────────
let busyWith = null;      // null | "run" | "refresh" — both own the same window
let stopRequested = false;
let workTabId = null;
let workWindowId = null;
let sending = false;     // true only while the lead loop is running
let driverLost = null;   // reason, once Chrome takes the debugging session away
let reloadsThisLead = 0; // how many times the page came back under the lead in flight
// True only while this worker is actually DRIVING the run — the prep, or a lead.
// In the pause between leads the run is a pending alarm and nothing else, so
// there is nobody to notice a stop flag; that is what stopRun() checks.
let active = false;

// ── messaging ──────────────────────────────────────────────────────────────────
function emit(type, payload = {}) {
  chrome.runtime.sendMessage({ type, ...payload }).catch(() => {});
}
function log(text, level = "info") {
  emit("LOG", { text, level, ts: Date.now() });
}
async function pushState(patch) {
  const state = await setRunState(patch);
  emit("PROGRESS", { state });
  return state;
}

// Update one lead and tell the page WHICH one moved, so it can patch a single
// row instead of reloading a queue that may run to thousands.
async function markLead(id, patch) {
  const list = await updateLead(id, patch);
  emit("LEADS_CHANGED", { lead: list.find((l) => l.id === id) });
}

function closeWork() {
  if (workWindowId != null) {
    const id = workWindowId;
    workWindowId = null;
    workTabId = null;
    chrome.windows.remove(id).catch(() => {});
  }
}

// ── the inbox, as it arrives ───────────────────────────────────────────────────
// Instagram fetches its own inbox payloads while the work window sits in Direct;
// cdp.js hands us those response bodies and we keep the derived reply facts.
// Nothing is requested — see src/inbox.js.
let capturedBodies = [];
let capturedStatuses = [];

// The same traffic answers a second question, per lead: whether a conversation
// with them exists at all. Kept for the whole run, because opening a thread the
// page has already shown fetches nothing — the answer has to survive from the
// first time Instagram gave it. See readConversations in inbox.js.
let conversations = {};

cdp.onInboxTraffic((body, status) => {
  capturedStatuses.push(status);
  if (body) capturedBodies.push(body);
});

// Fold whatever has arrived into the stored facts. Cheap when nothing has.
async function flushInbox() {
  if (!capturedBodies.length) return null;
  const bodies = capturedBodies;
  const statuses = capturedStatuses;
  capturedBodies = [];
  capturedStatuses = [];

  conversations = { ...conversations, ...readConversations(bodies) };
  const block = blockSignal(statuses);
  const threads = parseInboxBodies(bodies);
  if (threads.length) {
    await setInbox(mergeFacts(await getInbox(), threads));
    emit("INBOX_CHANGED");
  }
  return block;
}

// ── losing the hands ───────────────────────────────────────────────────────────
// Without the driver nothing can be clicked or typed, so there is no point
// carrying on: every remaining lead would fail on its first click and the queue
// would empty itself into `failed`. Stop the run instead, and leave the leads
// pending so the user can just start again.
const DETACH_REASONS = {
  canceled_by_user: "the debugging bar was cancelled",
  replaced_with_devtools: "DevTools opened on the work window",
  target_closed: "the work window was closed",
};

cdp.onDriverLost((reason) => {
  // Only while leads are actually being worked: our own teardown, Stop, and the
  // few seconds the window lingers after the last lead all detach too, and none
  // of those is something to report.
  if (!sending || stopRequested) return;
  driverLost = DETACH_REASONS[reason] || `the input driver detached (${reason})`;
  stopRequested = true;                   // reuse the stop path: no bogus failures
  setRunState({ stopRequested: true });
  log(`${driverLost} — stopping, the remaining leads stay pending`, "error");
});

// Did this come from the tab the run is driving? A resurrected worker has
// forgotten which that is (see recallWork), and refusing its own tab over its
// own amnesia fails the lead — so it reads the tab back before turning anyone
// away. Storage is touched once per worker: after that workTabId is set.
async function isWorkTab(sender) {
  if (sender.tab?.id == null) return false;
  if (workTabId == null) await recallWork();
  return sender.tab.id === workTabId;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  if (msg.type === "START") {
    // `resume` carries the last run's tally over instead of zeroing it — see startRun().
    startRun(!!msg.resume).catch((e) => { log(`error: ${e.message}`, "error"); finishRun(); });
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === "STOP") {
    stopRun().catch((e) => log(`error: ${e.message}`, "error"));
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === "REFRESH_INBOX") {
    refreshInbox().catch((e) => log(`error: ${e.message}`, "error"));
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === "GET_STATE") {
    getRunState().then(sendResponse);
    return true;
  }
  if (msg.type === "AUDIENCE") {
    // Same rule as INPUT below, and for the same reason: this answer decides a
    // lead and writes their numbers onto it, so only the tab the run is driving
    // may ask it. The content layer lives in the user's own Instagram tabs too.
    //
    // Asked through isWorkTab rather than against workTabId directly: this is
    // the one message that lands after the quietest stretch of a lead — the walk
    // from the thread to the profile — and a worker Chrome replaced in that
    // window knows no work tab until it reads one back.
    isWorkTab(sender)
      .then((mine) => (mine
        ? judgeAudience({ followers: msg.followers, posts: msg.posts })
        : { error: "the audience check is only allowed from the work tab" }))
      .then(sendResponse)
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === "INPUT") {
    // Only the work tab may drive input. The content layer is injected into
    // every Instagram page, including the user's own tabs — those must never be
    // able to move the mouse or type.
    isWorkTab(sender)
      .then((mine) => (mine
        ? dispatchInput(msg).then(() => ({ ok: true }))
        : { ok: false, error: "input is only allowed from the work tab" }))
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === "CONTENT_READY") {
    // The work tab came back with a fresh content layer — Instagram reloaded, or
    // we pressed the Reload on its error screen. Two things follow: the hands
    // have to go back on (they live in a page that no longer exists), and the
    // lead in flight has to be counted, because a page that keeps reloading is a
    // lead that keeps starting over.
    isWorkTab(sender).then((mine) => {
      if (!mine) return;
      if (sending) {
        reloadsThisLead++;
        // Otherwise the log reads as one long confused walk: this is where the
        // last attempt was thrown away and the lead started again.
        log(`  the page reloaded under the lead — picking it up again (${reloadsThisLead})`);
      }
      showHands(true);
    });
    return false;
  }
  if (msg.type === "CONVERSATION") {
    // The content layer asking what Instagram itself said about this lead's
    // thread. Answered from traffic the page fetched on its own; `known: false`
    // when it said nothing, and then the page falls back to reading the screen.
    isWorkTab(sender)
      .then(async (mine) => {
        if (!mine) return { known: false };
        await flushInbox();
        const said = conversations[String(msg.username || "").toLowerCase()];
        return said ? { known: true, ...said } : { known: false };
      })
      .then(sendResponse)
      .catch(() => sendResponse({ known: false }));
    return true;
  }
  if (msg.type === "STEP") {
    // Per-step progress from the content script → indented line in the run log.
    log("    " + msg.text);
    return false;
  }
  return false;
});

// One queue for every click and keystroke, because CDP has no idea who is
// typing. Two typeText calls running at once do not produce two messages: their
// keystrokes interleave into whatever field has focus and BOTH come out
// shredded. A lead received "yo, where are producers finding ayrot,iwshtesr ef
// oarr e wporrokdu cneroswa" — two copies of one sentence, letter by letter.
// Serialising here cannot fix the caller that asked twice, but it makes the
// corruption impossible whatever the caller does.
let inputQueue = Promise.resolve();

function dispatchInput(msg) {
  const next = inputQueue.then(() => doInput(msg), () => doInput(msg));
  inputQueue = next.catch(() => {});   // one failed op must not poison the queue
  return next;
}

// The content script's requests for real input, in viewport coordinates.
async function doInput(msg) {
  switch (msg.op) {
    case "click": return cdp.click(msg.x, msg.y);
    case "move":  return cdp.moveTo(msg.x, msg.y);
    case "type":  return cdp.typeText(msg.text, msg.speed);
    case "clear": return cdp.clearField();
    case "wheel": return cdp.wheel(msg.dy);
    case "key":
      if (msg.key === "Enter") return cdp.pressEnter();
      if (msg.key === "Escape") return cdp.pressEscape();
      throw new Error(`unsupported key: ${msg.key}`);
    default: throw new Error(`unknown input op: ${msg.op}`);
  }
}

// The toolbar icon belongs to the suite now: one click opens this page, the CRM
// and Instagram together as a tab group (../../workspace.js).

// ── tab plumbing ────────────────────────────────────────────────────────────────
// A separate window (not a background tab in the same window, which Chrome would
// throttle). Opened focused so the user actually sees it start; a focused window is
// never throttled. They can push it behind their work — a visible non-focused window
// still isn't throttled.
// Size is not cosmetic: below roughly 900px Instagram collapses Direct to a
// single column and hides the conversation list — search box and all — while a
// thread is open, and the left nav turns into a bottom bar. Pinning a desktop
// width keeps one layout for the whole run.
async function openWorkWindow(url, focused = true) {
  const win = await chrome.windows.create({ url, focused, state: "normal", width: 1280, height: 900 });
  renderingKept = false;   // a new window: say once whether it survives going off screen
  workWindowId = win.id;
  workTabId = win.tabs && win.tabs[0] ? win.tabs[0].id : null;
  return workTabId;
}

// Wait for the tab to finish loading — by WATCHING for `complete` and by ASKING
// whether it already is. Watching alone is a trap: a window that opens on a
// cached page can be complete before this listener exists, and then the event
// never comes again. The run just sits in a freshly opened window doing nothing
// until something else navigates the tab — reloading it by hand, say.
function waitTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(ok);
    };
    const listener = (id, info) => { if (id === tabId && info.status === "complete") finish(true); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    // Listener first, then the current state, so the answer cannot fall between them.
    chrome.tabs.get(tabId).then((t) => { if (t.status === "complete") finish(true); }, () => finish(false));
  });
}

// The content layer, in load order — it shares one isolated world and each file
// uses what the earlier ones publish, so this list must match manifest.json.
// Paths are from the EXTENSION root, not this file — hence the folder prefix.
const CONTENT_SCRIPTS = [
  "outreach/src/content/dom.js",
  "outreach/src/content/hands.js",
  "outreach/src/content/input.js",
  "outreach/src/content/finders.js",
  "outreach/src/content/direct.js",
  "outreach/src/content/post.js",
  "outreach/src/content/story.js",
  "outreach/src/content/main.js",
];

// Every attempt is raced against a clock. A content handler that answers
// asynchronously and then never resolves leaves chrome.tabs.sendMessage pending
// for ever — the port stays open, so there is no error and no timeout of its
// own, and the whole run simply stops mid-step with nothing in the log. That is
// not hypothetical: a handler that awaited AudioContext.resume() under a blocked
// autoplay policy — which neither resolves nor rejects — did exactly this.
async function sendToContent(
  tabId, msg, { retries = 8, retryDelay = 500, injectOnFail = true, timeoutMs = 30000,
                retryAfterTimeout = true, maxReloads = null } = {}
) {
  let injected = false;
  let last = null;
  for (let i = 0; i < retries; i++) {
    if (stopRequested) throw new Error("stopped");
    // Every reload throws this call's answer away and the next attempt starts
    // the whole lead again, so a page Instagram cannot keep up would loop until
    // the retries ran out — a minute a go, watched three times over in one log.
    if (maxReloads != null && reloadsThisLead > maxReloads) {
      throw new Error(`Instagram reloaded the page ${reloadsThisLead} times while working this lead`);
    }
    try {
      const res = await Promise.race([
        chrome.tabs.sendMessage(tabId, msg),
        sleep(timeoutMs).then(() => {
          const e = new Error(`the page took more than ${Math.round(timeoutMs / 1000)}s to answer ${msg.type}`);
          e.timedOut = true;
          return Promise.reject(e);
        }),
      ]);
      if (res !== undefined) return res;
    } catch (e) {
      last = e;
      // A call that timed out has NOT stopped — the page is still working on it.
      // Asking again is only safe when asking twice is harmless, which a send is
      // not: the second one types into the same box as the first.
      if (e.timedOut && !retryAfterTimeout) throw e;
      if (injectOnFail && !injected && i >= 2) {
        injected = true;
        try { await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPTS }); }
        catch (_e2) { /* page may disallow injection mid-navigation */ }
      }
    }
    await sleep(retryDelay);
  }
  // Why it gave up, not just that it did: "no receiving end" and "took too long
  // to answer" are different bugs and want different fixes.
  throw new Error(`content script not responding${last ? ` — ${last.message}` : ""}`);
}

// A reloaded page comes back with a fresh, empty content layer — including hands
// that have forgotten they were ever on screen — so the run re-asserts them
// every time it checks the page is alive, and re-asserts the rendering override
// with them. The override outlives a navigation on its own; sending it again is
// one command and removes the question.
async function ensureContent(tabId) {
  const hello = await sendToContent(tabId, { type: "PING" }, { retries: 14, retryDelay: 400, timeoutMs: 5000 });
  await showHands(true);
  await keepWindowLive();
  return hello;
}


// One variant per lead, at random. Which one actually went out is recorded on
// the lead (sentMessageId), so opener performance is measured from real sends
// rather than arranged by a setting.
function pickTemplate(messages) {
  return messages[Math.floor(Math.random() * messages.length)];
}

// The run lives in Direct: the work window opens there once, and the content
// script walks to each lead through Instagram's own search rather than being
// navigated to a profile URL. Nobody reaches a lead by typing their address.
const INBOX_URL = "https://www.instagram.com/direct/inbox/";

// Failures in a row that mean "this isn't about the leads" — see the check in
// the run loop.
const MAX_CONSECUTIVE_FAILURES = 3;

// ── the run: one lead per step, driven by an alarm ────────────────────────────
// The loop lives in the QUEUE, not in this worker's memory. Each step asks
// storage for the next pending lead, does it, and sets an alarm for the pause
// before the next one.
//
// That shape is what makes the pause an alarm rather than a poll. Chrome may
// suspend an idle service worker, and an `await` on a timer is not activity —
// the old code had to read storage every 500ms purely to stay alive through a
// 90-second wait. With the position in storage, a suspended worker is fine: the
// alarm wakes a fresh one and it picks the run up exactly where it was.
const STEP_ALARM = "igsender-step";

// The work window, in storage for the same reason: a resurrected worker still
// has to find the window it opened.
async function rememberWork() {
  await set(KEYS.work, { windowId: workWindowId, tabId: workTabId });
}

async function recallWork() {
  if (workTabId != null) return true;
  const w = await get(KEYS.work, null);
  if (!w) return false;
  try { await chrome.windows.get(w.windowId); } catch (_e) { return false; }
  workWindowId = w.windowId;
  workTabId = w.tabId;
  return true;
}

// Open the work window, take the controls, and read the inbox. A send run and a
// plain refresh want exactly this and differ only in what happens next, so it
// lives in one place.
async function openAndRead({ focused = true, passes = 4, onPhase = async () => {} } = {}) {
  log("opening Direct");
  await onPhase("opening");
  const tabId = await openWorkWindow(INBOX_URL, focused);
  if (tabId == null) throw new Error("could not create work window");
  // Recorded the moment it exists, not once the scan is done: a worker that dies
  // during the scan would otherwise leave a window nothing can find again.
  await rememberWork();
  // Loud, not silent: carrying on into a half-loaded page is the difference
  // between "the run is slow" and "the run is broken", and only the log can say which.
  if (!(await waitTabComplete(tabId))) log("  the page never finished loading — carrying on anyway", "error");
  // Trusted input. This is what puts Chrome's "extension is debugging this
  // browser" bar on the work window.
  try {
    await cdp.attach(tabId, await getHumanSeed());
  } catch (e) {
    throw new Error(
      `could not attach the input driver: ${e.message}. Close DevTools on the work ` +
      `window and check that no other extension is debugging it.`
    );
  }
  // Worth one line: every layout question in this extension comes back to it.
  const hello = await ensureContent(tabId);
  log(`work window viewport ${hello.w}×${hello.h}`);

  // Instagram fetches its own inbox payloads; a scroll through the conversation
  // list is all it needs to fetch the rest. Nothing is requested by us.
  capturedBodies = [];
  capturedStatuses = [];
  conversations = {};
  log("reading the inbox");
  await onPhase("inbox");
  // Scrolling the conversation list is minutes of work on a big inbox, so this
  // one is allowed far longer than the default before it counts as unanswered.
  const scan = await sendToContent(tabId, { type: "SCAN_INBOX", passes },
    { retries: 3, retryDelay: 800, timeoutMs: 180000 })
    .catch((e) => ({ ok: false, error: e.message }));
  // Not an error level: a run whose inbox scan hiccuped still sends perfectly
  // well, it just reports yesterday's replies. Errors are for things that stop
  // the run, and burying those in analytics noise is how they get missed.
  if (!scan || !scan.ok) {
    log(`  inbox not read (${(scan && scan.error) || "the page didn't answer"}) — reply data stays as it was`);
  }
  const block = await flushInbox();
  if (block) log(`  Instagram is throttling the inbox (${block}) — reply data may be stale`);
  const seen = Object.keys(await getInbox()).length;
  log(`  ${seen} conversation${seen === 1 ? "" : "s"} known`);

  // Who is doing the sending — one call about our own account, for the card
  // above the dashboard.
  const who = await sendToContent(tabId, { type: "OWN_PROFILE" }, { retries: 2, retryDelay: 600 })
    .catch(() => ({ ok: false }));
  if (who && who.ok && who.profile) {
    await setProfile(await keepAvatar(tabId, who.profile));
    emit("PROFILE_CHANGED");
    log(`  sending as @${who.profile.username}`);
  }
  return tabId;
}

// Instagram signs its avatar URLs and they expire within days, so a card drawn
// from a stored URL is blank a run or two later — which is what "the avatar
// doesn't load" was. Keep the bytes instead, taken while the URL is still fresh.
// A profile picture is tens of kilobytes and the extension has unlimitedStorage.
//
// The bytes come the same way the inbox does: the page is asked to load the
// picture and the debugger reads the response (armCapture in cdp.js). This
// used to be a fetch() from here, which is the one request in this project that
// went out under our own name rather than Instagram's — and it is the CDN's
// business whether to answer that. Going through the page also took two CDN
// domains out of the manifest's host permissions, which existed for it alone.
//
// Every way this can fail says so: an avatar that quietly never arrives is a
// card that quietly falls back to initials, which is exactly the bug that was
// reported.
async function keepAvatar(tabId, profile) {
  if (!profile.avatar) {
    log("  Instagram gave us no avatar URL — the card falls back to initials", "error");
    return profile;
  }
  try {
    // Armed before the page is asked, or the response goes past unheard.
    await cdp.armCapture(profile.avatar);
    const asked = await chrome.tabs.sendMessage(tabId, { type: "PULL", url: profile.avatar })
      .catch((e) => ({ ok: false, error: e.message }));
    if (!asked || !asked.ok) throw new Error(`the page couldn't load it (${(asked && asked.error) || "no answer"})`);
    const got = await cdp.captured();
    if (!got) throw new Error("the picture loaded but its bytes were gone before we could read them");
    // base64 is 4 characters per 3 bytes, so this is the old half-megabyte cap.
    if (got.base64.length > 700000) {
      throw new Error(`${Math.round(got.base64.length * 3 / 4096)}KB is more than a face needs`);
    }
    return { ...profile, avatarData: `data:${got.mimeType || "image/jpeg"};base64,${got.base64}` };
  } catch (e) {
    log(`  couldn't keep the avatar (${e.message}) — the card falls back to initials`, "error");
    return profile;
  }
}

// Read the inbox without sending anything — the dashboard's Refresh. Opens the
// window unfocused: nobody needs to watch this, and the audio keeps it running
// even though it is never on screen.
async function refreshInbox() {
  if (busyWith === "run") return void log("busy — wait for the run to finish");
  if (busyWith === "refresh") return void log("already reading the inbox");
  busyWith = "refresh";
  emit("INBOX_REFRESH", { busy: true });
  try {
    cdp.setSentInSession(0);
    await openAndRead({ focused: false, passes: 6 });
    await sleep(rand(600, 1200));
    await flushInbox();          // anything that landed while we were scrolling
  } catch (e) {
    log(`could not read the inbox: ${e.message}`, "error");
  } finally {
    await cdp.detach();
    closeWork();
    busyWith = null;
    emit("INBOX_REFRESH", { busy: false });
    emit("INBOX_CHANGED");
    log("inbox up to date");
  }
}

// `resume` picks the last run's tally up instead of zeroing it. The cap in
// Settings counts against that tally, so a limit of 20 that stopped at 5 sends
// the remaining 15 rather than another 20 — which of the two happens is the
// choice offered on Start (src/ui/run.js).
//
// Follow-ups are not carried. Their cap is per run on purpose, and what is owed
// is a clock, not a counter: a step that went out is not due again for another
// followupAfterHours whether this run remembers it or not.
async function startRun(resume = false) {
  // A run and a standalone inbox refresh own the same window and the same
  // debugger session, so they cannot overlap — and the refusal has to say which
  // of the two is in the way, or it reads as nonsense while a run winds down.
  if (busyWith === "refresh") return void log("busy — the inbox is being read, try again in a moment");
  if (busyWith === "run") return void log("a run is already in progress");
  const prev = await getRunState();
  if (prev.running) {
    // Storage can go on claiming a run after the worker — or Chrome — died. A
    // live run always has either this worker or a scheduled step behind it; with
    // neither, nothing owns that state and refusing here locks Start out for good.
    if (await chrome.alarms.get(STEP_ALARM)) return void log("a run is already in progress");
    log("the last run was interrupted — picking the queue back up");
    // Torn down in full, not just unwound far enough to start again: the checks
    // below can still refuse, and leaving storage claiming a run after THAT is
    // the same lock-out by a different door.
    await recallWork();
    await finishRun();
  }

  const [messages, leads, steps, settings, inbox] = await Promise.all([
    getMessages(), getLeads(), getFollowups(), getSettings(), getInbox(),
  ]);
  const pending = leads.filter((l) => l.status === STATUS.pending && !l.removed);
  const due = dueFollowups(leads.filter((l) => !l.removed), inbox, steps, settings);
  if (!messages.some((m) => m.text.trim())) return void log("no messages configured", "error");
  if (!pending.length && !due.length) {
    return void log("nothing to send — no pending leads and no follow-ups due", "error");
  }
  if (due.length) log(`${pending.length} to write to, ${due.length} follow-up${due.length === 1 ? "" : "s"} due`);

  // The run needs a connected Artist Outreach account with an active plan and
  // something left of today's allowance. Asked before the window opens, so a
  // refusal costs nothing.
  const allowed = await checkRunAllowed();
  if (!allowed.ok) return void log(allowed.message, "error");
  log(describeQuota(allowed.quota));

  const carried = resume ? { sent: prev.sent || 0, failed: prev.failed || 0 } : { sent: 0, failed: 0 };
  if (carried.sent) {
    log(`carrying on from ${carried.sent} sent`
      + (settings.maxPerRun > 0 ? ` — ${Math.max(0, settings.maxPerRun - carried.sent)} left of ${settings.maxPerRun}` : ""));
  }

  busyWith = "run";
  stopRequested = false;
  driverLost = null;
  active = true;

  // Marked running BEFORE the window opens: opening Direct and scanning the
  // inbox take tens of seconds, and until this lands the page has no idea a run
  // began — the button still says Start while a second press is already being
  // told a run is in progress.
  await pushState({
    running: true, stopRequested: false, phase: "opening",
    total: pending.length + due.length, followupTotal: due.length,
    ...carried, followupsSent: 0, consecutiveFailures: 0,
    currentIndex: -1, startedAt: Date.now(),
  });

  try {
    try {
      // The hands warm up and then tire over a session; a continued run is the
      // same session, so they pick up as tired as they were left.
      cdp.setSentInSession(carried.sent);
      await openAndRead({ focused: true, passes: 4, onPhase: (phase) => pushState({ phase }) });
    } catch (e) {
      log(`could not start: ${e.message}`, "error");
      await finishRun();
      return;
    }
    await pushState({ phase: "sending" });
    await step();
  } finally {
    active = false;
  }
}

// An occluded window stops rendering, and Instagram stops with it — see
// keepRendering() in cdp.js. Said once, and said loudly if Chrome refuses it,
// because that is the difference between a run that survives being pushed onto
// another desktop and one that stands still there.
let renderingKept = false;

async function keepWindowLive() {
  try {
    await cdp.keepRendering();
    if (renderingKept) return;
    renderingKept = true;
    log("  the window keeps working off screen");
  } catch (e) {
    renderingKept = false;
    log(`  this window will freeze when it goes off screen (${e.message}) — keep it visible`, "error");
  }
}

// Stop, whoever is holding the run. Something actually executing — a lead, or
// the prep before the first one — notices the flag and winds itself down. Two
// cases have no such executor and must be ended right here, or storage goes on
// claiming a run for ever with the button stuck on Stop and every later Start
// refused: after the extension is reloaded mid-run, and in the pause BETWEEN
// leads, where the whole run is one pending alarm.
async function stopRun() {
  stopRequested = true;
  chrome.alarms.clear(STEP_ALARM);   // a pause must not wake into a stopped run
  log("stopping");
  if (active) {
    await setRunState({ stopRequested: true });
    closeWork();                     // aborts whatever the page was mid-way through
    return;
  }
  await recallWork();                // so the window left behind is closed too
  await finishRun();
}

// The hands hang over the work window for as long as the run lasts. Nothing
// depends on them, so a page that doesn't answer is not worth a word in the log.
// The skin rides along with every message: a reloaded page comes back with a
// content layer that has forgotten which pair it was wearing.
async function showHands(on) {
  if (workTabId == null) return;
  const skin = handSkin((await getSettings()).handSkin);
  await chrome.tabs.sendMessage(workTabId, { type: "HANDS", on, skin }).catch(() => {});
}

// The alarm fires into a worker that may be brand new: no cdp session, no tab
// id, none of the in-memory state. Rebuild what the step needs, then step.
async function resumeRun() {
  const state = await getRunState();
  if (!state.running || state.stopRequested) return;
  if (!(await recallWork())) {
    log("the work window is gone — stopping, the remaining leads stay pending", "error");
    return finishRun();
  }
  busyWith = "run";
  active = true;
  try {
    if (!cdp.isAttached()) {
      try {
        cdp.setSentInSession(state.sent || 0);
        await cdp.attach(workTabId, await getHumanSeed());
        await ensureContent(workTabId);
      } catch (e) {
        log(`could not pick the run back up: ${e.message}`, "error");
        return finishRun();
      }
    }
    await step();
  } finally {
    active = false;
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === STEP_ALARM) resumeRun().catch((e) => { log(`error: ${e.message}`, "error"); finishRun(); });
});

// ── the audience filter ───────────────────────────────────────────────────────
// The content script reads the two numbers off the lead's profile and asks here
// what they mean, because the rule lives in a module it cannot import. The lead
// being worked on is the one this answers about — there is only ever one.
async function judgeAudience(counts) {
  const settings = await getSettings();
  const unreadable = unreadableCounts(counts);
  if (unreadable) return { error: unreadable };

  const seen = `${formatCount(counts.followers)} followers · ${formatCount(counts.posts)} posts`;
  const lead = (await getLeads()).find((l) => l.status === STATUS.sending);
  // Kept on the lead whichever way the verdict goes: it is what makes the skip
  // note arguable, and what the queue holds for everyone else.
  if (lead) await markLead(lead.id, { followers: counts.followers, posts: counts.posts });

  const verdict = audienceVerdict(counts, settings);
  return { pass: verdict.pass, reason: verdict.reason, seen };
}

// One unit of work — a first-touch DM, or a follow-up once the DMs have run
// out. Pick it, send it, record it, then decide whether the run carries on.
async function step() {
  // A lead already in flight and another step starting is two sends typing into
  // one composer — the failure that shredded a message into "ayrot,iwshtesr ef
  // oarr". Nothing legitimate does this, so say so loudly rather than proceed.
  if (sending) return void log("a lead is already being sent — a second step was ignored", "error");
  const state = await getRunState();
  if (!state.running || state.stopRequested || stopRequested) return endRun(state);

  const [tables, settings, messages, leads, steps, inbox] = await Promise.all([
    getTables(), getSettings(), getMessages(), getLeads(), getFollowups(), getInbox(),
  ]);
  const templates = messages.filter((m) => m.text.trim());
  if (!templates.length) return endRun(state);
  // A lead left `sending` by a worker that died mid-step would never be picked
  // again — put it back in the queue before choosing.
  const stale = leads.find((l) => l.status === STATUS.sending);
  if (stale) await markLead(stale.id, { status: STATUS.pending });

  const job = nextJob({
    leads: stale ? await getLeads() : leads, inbox, steps, settings, state,
  });
  if (!job) return endRun(state);

  const { kind, lead } = job;

  // One unit of the day's allowance, taken before anything is typed — and
  // before the lead is marked, so a refusal leaves the queue exactly as it was.
  const claim = await claimDm();
  if (!claim.ok) {
    log(claim.message, "error");
    return endRun(state, claim.error === "daily_limit" ? "limit" : "platform");
  }

  const lookup = mergedLookup(tables);
  const vars = lookup[lead.handle] || { username: lead.handle };
  // A follow-up has one path and no choice about it: back to Direct, search,
  // open the conversation, type. No profile, no post, no story — and no
  // skip-existing check, since a conversation existing is the whole premise.
  const template = kind === "followup" ? job.step : pickTemplate(templates);
  const message = personalize(applySpintax(template.text), vars);
  const format = kind === "followup"
    ? "justDM"
    : enabledFormats(settings)[Math.floor(Math.random() * enabledFormats(settings).length)];
  // Follow-ups are never filtered: the conversation is already open between us,
  // and turning someone away half way through a sequence is not a filter, it is
  // a dropped thread. The filter arrives as one flag so the content layer never
  // has to know what "switched on with no bound set" means.
  const sendSettings = kind === "followup"
    ? { ...settings, format, skipExisting: false, audienceFilter: false }
    : { ...settings, format, audienceFilter: audienceFilterOn(settings) };

  const index = (state.currentIndex ?? -1) + 1;
  if (kind === "dm") await markLead(lead.id, { status: STATUS.sending });
  await pushState({ currentIndex: index, phase: kind === "followup" ? "followups" : "sending" });
  log(kind === "followup"
    ? `(${index + 1}/${state.total}) @${lead.handle} · follow-up ${job.index + 1}`
    : `(${index + 1}/${state.total}) @${lead.handle} · ${format}`);

  sending = true;
  reloadsThisLead = 0;
  let result;
  try {
    // No navigation between leads: the content script walks back to Direct
    // itself and finds the next lead through search, so the page — and this
    // content script — stay alive for the whole run. The one exception is a lead
    // Direct's search cannot find, below.
    await ensureContent(workTabId);
    result = await sendToContent(
      workTabId,
      { type: "SEND", payload: { username: lead.handle, message, settings: sendSettings } },
      // A whole lead — search, open, type at human speed, submit — is the one
      // call here that legitimately runs for minutes. Two reloads under it are
      // plenty: past that Instagram is not going to serve this lead today, and
      // every further attempt is another minute walking to the same broken page.
      { retries: 6, retryDelay: 600, timeoutMs: 600000, retryAfterTimeout: false, maxReloads: 2 }
    );
    // Instagram's own search doesn't always find an account that exists — a
    // handle it is still indexing, a throttled search — and skipping the lead for
    // that is worse than one navigation. This is the ONLY place the run types an
    // address, it happens only once search has given up, and what the profile
    // says (404, private, no Message button) is what decides the lead.
    if (result && result.status === "notInSearch" && !stopRequested) {
      result = await sendViaProfile(lead.handle, message, sendSettings);
    }
  } catch (e) {
    result = { status: "failed", error: e.message };
    // We stopped waiting; the page did not stop working. Left alone it goes on
    // clicking for a lead nobody wants any more, and answers the NEXT lead with
    // "busy sending to @…" — three of those in a row stop the run.
    chrome.tabs.sendMessage(workTabId, { type: "ABANDON" }).catch(() => {});
  } finally {
    sending = false;
  }

  // Nothing went out (skipped, failed, blocked, aborted): the unit goes back.
  if (result?.status !== "sent") releaseDm(claim.day);

  // Stop pressed mid-send: don't record a bogus failure — roll back to pending.
  if (stopRequested || (await getRunState()).stopRequested) {
    if (kind === "dm") await markLead(lead.id, { status: STATUS.pending, error: undefined });
    log("  → aborted");
    return endRun(await getRunState());
  }

  // Instagram itself is refusing — an action block or a rate limit. The next
  // lead walks into the same wall, so stop: carrying on burns the queue and
  // deepens the block. Nothing went out, so this lead stays pending too.
  if (result.status === "blocked") {
    if (kind === "dm") await markLead(lead.id, { status: STATUS.pending, error: undefined });
    log(`Instagram refused: "${result.error}" — stopping, the remaining leads stay pending`, "error");
    log("wait it out before starting again — an hour at least, longer if it repeats");
    return endRun(await getRunState(), "blocked");
  }

  const counts = await getRunState();
  let { sent = 0, failed = 0, followupsSent = 0, consecutiveFailures = 0 } = counts;
  if (result.status === "sent") {
    consecutiveFailures = 0;
    if (kind === "followup") {
      followupsSent++;
      // Appended, never replacing `ts`: the dashboard's activity grid and hour
      // chart are about when the OPENER went out, and a follow-up months later
      // must not move that lead to today.
      await markLead(lead.id, {
        followups: [...(lead.followups || []), { ts: Date.now(), stepId: template.id, text: message }],
        followupError: undefined,
      });
      log(`  → follow-up ${job.index + 1} sent`);
    } else {
      sent++;
      cdp.setSentInSession(sent); // the hands warm up, then tire
      // What went out, to whom, through which path and in which conversation.
      // None of it can be reconstructed later, and every later block — reply
      // rates per opener, follow-ups — reads exactly these fields.
      await markLead(lead.id, {
        status: STATUS.sent, ts: Date.now(), error: undefined,
        sentMessageId: template.id, sentText: message, format,
        threadId: result.threadId,
      });
      log("  → sent");
    }
  } else if (result.status === "skipped") {
    consecutiveFailures = 0;         // a skip means the machinery still works
    if (kind === "followup") {
      // Unreachable through Direct search — gone, renamed, or they blocked us.
      // Retrying that every run costs a search and finds the same nothing.
      await markLead(lead.id, { followupsOff: true, followupError: result.reason });
      log(`  → follow-ups stopped for @${lead.handle} (${result.reason || "not reachable"})`);
    } else {
      await markLead(lead.id, { status: STATUS.skipped, ts: Date.now(), error: result.reason });
      log(`  → skipped (${result.reason || "skipped"})`);
    }
  } else {
    failed++;
    consecutiveFailures++;
    if (kind === "followup") {
      await markLead(lead.id, { followupError: result.error });
      log(`  → follow-up failed: ${result.error || "unknown"}`, "error");
    } else {
      await markLead(lead.id, { status: STATUS.failed, ts: Date.now(), error: result.error });
      log(`  → failed: ${result.error || "unknown"}`, "error");
    }
  }

  const next = await pushState({ sent, failed, followupsSent, consecutiveFailures });
  await flushInbox();   // opening the lead's conversation refreshed its thread

  // Leads fail one at a time for their own reasons; several in a row means
  // something systemic — Instagram changed its markup, or we're logged out.
  // Working through the rest of the list would just produce the same error with
  // every lead marked failed.
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    log(`${consecutiveFailures} leads failed in a row — stopping. The untouched leads stay pending; ` +
      `the errors above say what broke.`, "error");
    return endRun(next, "failures");
  }

  // Ask now whether there is anything left, rather than sleeping a minute and
  // finding out then: a log that says "wait 60s" and then "done" is a run that
  // looks like it hung.
  const more = nextJob({ leads: await getLeads(), inbox: await getInbox(), steps, settings, state: next });
  if (!more) return endRun(next);

  // The pause is shorter between follow-ups: those go into conversations that
  // already exist, which is not the action Instagram meters.
  const base = rand(settings.perLeadDelayMin, settings.perLeadDelayMax);
  const wait = Math.round(kind === "followup" ? base * FOLLOWUP_PACE : base);
  log(`  wait ${Math.round(wait / 1000)}s`);
  scheduleStep(wait);
}

// The lead again, from their profile instead of Direct's search — the one
// navigation a run makes. The content layer takes the other way in from there
// (the profile's Message button) and answers with the lead's real outcome; a
// profile that 404s is how we learn the account is genuinely gone.
async function sendViaProfile(username, message, settings) {
  log(`  not in Direct's search — opening instagram.com/${username}`);
  await chrome.tabs.update(workTabId, { url: `https://www.instagram.com/${username}/` });
  if (!(await waitTabComplete(workTabId))) log("  their profile never finished loading — carrying on anyway");
  await ensureContent(workTabId);
  reloadsThisLead = 0;   // this navigation is ours, not Instagram falling over
  return sendToContent(
    workTabId,
    { type: "SEND", payload: { username, message, settings: { ...settings, viaProfile: true } } },
    { retries: 6, retryDelay: 600, timeoutMs: 600000, retryAfterTimeout: false, maxReloads: 2 }
  ).catch((e) => ({ status: "failed", error: e.message }));
}

// chrome.alarms takes minutes, and clamps anything under a minute to a minute
// for packed extensions — a fraction is the documented way to ask for seconds,
// and unpacked builds honour it.
function scheduleStep(ms) {
  chrome.alarms.create(STEP_ALARM, { delayInMinutes: Math.max(ms, 1000) / 60000 });
}

// ── desktop notifications ─────────────────────────────────────────────────────
// A run is a long unattended thing — the point of the window being pushable
// behind your work is that you stop watching it. So it says when it is over, and
// says louder when it gave up. Optional permission: nothing is requested until
// the switch in Settings is turned on, and Chrome asks before granting it.
const NOTICE = {
  done: { title: "Artist Outreach — run finished", priority: 0 },
  stopped: { title: "Artist Outreach — run stopped", priority: 0 },
  blocked: { title: "Artist Outreach — Instagram refused, run stopped", priority: 2 },
  failures: { title: "Artist Outreach — leads kept failing, run stopped", priority: 2 },
  limit: { title: "Artist Outreach — today's DM limit reached", priority: 1 },
  platform: { title: "Artist Outreach — couldn't check your plan, run stopped", priority: 2 },
};

// Three of the four ways this can come to nothing used to be a silent `return`,
// which is how "notifications don't work" looked from the inside: a switch that
// is on, a run that ends, and no word anywhere about why nothing appeared. The
// fourth way is not ours at all — macOS can be refusing Chrome's notifications
// outright, or sitting in a Focus mode, and Chrome reports neither. That one is
// caught in Settings, which fires a test notification the moment the switch goes
// on: if that one doesn't appear, none of them will.
async function notifyDone(reason, tally) {
  if (!(await getSettings()).notifyOnFinish) return;
  if (!chrome.notifications) {
    return void log("  no notification: Chrome hasn't given this extension the permission "
      + "— switch it off and on again in Settings", "error");
  }
  // The setting can outlive the permission — it is revocable from Chrome's own
  // extension page, where nothing tells us about it.
  const granted = await chrome.permissions.contains({ permissions: ["notifications"] }).catch(() => false);
  if (!granted) {
    return void log("  no notification: the permission was revoked "
      + "— switch it off and on again in Settings", "error");
  }
  const notice = NOTICE[reason] || NOTICE.done;
  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("outreach/icons/icon-128.png"),
      title: notice.title,
      message: tally,
      priority: notice.priority,
    });
  } catch (e) {
    log(`  the notification didn't go out (${e.message})`, "error");
  }
}

// `reason` is why the run is over, for the notification: "blocked" and
// "failures" are the two endings worth interrupting someone about.
async function endRun(state, reason = null) {
  chrome.alarms.clear(STEP_ALARM);
  sending = false;
  const aborted = stopRequested || (state && state.stopRequested);
  const s = state || await getRunState();
  await showHands(false);
  const tally = `sent ${s.sent || 0}, failed ${s.failed || 0}`
    + (s.followupsSent ? `, ${s.followupsSent} follow-up${s.followupsSent === 1 ? "" : "s"}` : "");
  log(`done — ${tally}`);
  await notifyDone(aborted ? "stopped" : reason, tally);
  if (!aborted) {
    await setRunState({ running: false, phase: null, currentIndex: -1 });
    emit("PROGRESS", { state: await getRunState() });
    log("closing the work window in a few seconds…");
    await sleep(rand(4000, 8000));
  }
  await finishRun();
}



// Tear the run down: no alarm left to wake into a finished run, no debugger on
// the user's browser, no work window, and nothing in storage claiming a run is
// still going.
async function finishRun() {
  chrome.alarms.clear(STEP_ALARM);
  await set(KEYS.work, null);
  busyWith = null;
  sending = false;
  stopRequested = false;
  driverLost = null;
  await cdp.detach();
  closeWork();
  await setRunState({ running: false, stopRequested: false, phase: null, currentIndex: -1, consecutiveFailures: 0 });
  emit("PROGRESS", { state: await getRunState() });
}
