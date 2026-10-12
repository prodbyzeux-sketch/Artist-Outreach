// Service worker: owns the data, orchestrates refreshes, holds no UI.
//
// Refresh path, mirroring siluet's capture strategy (App.swift:15178):
//
//   refresh ──▶ template + an open Instagram tab? ──yes──▶ replay in that tab
//                        │ no                                     │
//                        ▼                                        ▼
//              background tab → its own traffic     threads? ─yes─▶ ingest
//              is the capture → close it            │ no
//                                                   ▼
//                                          429 / challenge? → report
//                                          otherwise → template is stale,
//                                          drop it and take the tab path once
//
// The worker is killed between events, so nothing lives in memory that matters:
// every fact is in chrome.storage.local.

import { createStore } from './lib/store.js';
import {
  parseInboxBodies, parseThreadPage, threadIDFromURL, classifyInboxBlock, threadListCursor,
  swapThreadURL, swapThreadVariables, pagingProbe, variableKeys, requestVariables, canPaginate,
} from './lib/parser.js';
import { walkInbox, walkThread, scrollInbox } from './lib/backfill.js';
import { AVATAR_PX, MAX_SOURCE_BYTES, staleAvatars } from './lib/avatars.js';
import { insertAndSend } from './trusted-input.js';

const store = createStore(chrome.storage.local);

// Which build is actually running. Two edits in a row failed to show up in the
// browser and there was no way to tell a stale worker from a wrong diagnosis.
const BUILD = 'scroll-the-list-6';
store.patchHealth({ build: BUILD }).catch(() => {});

const IG_INBOX_URL = 'https://www.instagram.com/direct/inbox/';
const threadURL = (threadID) => `https://www.instagram.com/direct/t/${encodeURIComponent(threadID)}/`;
const CAPTURE_TIMEOUT_MS = 12000;
// Tab ids mean nothing after a browser restart, so the link lives in session
// storage: it outlives the worker being killed, and dies with the browser.
const LINK_KEY = 'linkedTabId';

const looksLikeThreads = (body) =>
  typeof body === 'string' && (body.includes('slide_messages') || body.includes('threads_by_folder'));

/** Tabs waiting for their first inbox capture, keyed by tab id. */
const awaitingCapture = new Map();

// ── Ingest ────────────────────────────────────────────────────────────────

/**
 * `faces` is off while walking the inbox: a page brings up to a dozen pictures,
 * and a hundred and fifty pages of that is a couple of thousand image requests
 * interleaved with the walk. The walk fetches them once, at the end.
 */
async function ingestBody(body, { faces = true } = {}) {
  const threads = parseInboxBodies([body]);
  if (!threads.length) {
    // The body announced itself as an inbox but produced nothing — Instagram's
    // response shape moved. Say so instead of showing a silently empty list.
    await store.patchHealth({ lastError: 'parse', lastErrorAt: Date.now() });
    return { threads: 0, added: 0, updated: 0, newInbound: 0, cursor: null };
  }

  const byViewer = new Map();
  for (const t of threads) {
    const key = t.viewerID || '';
    if (!byViewer.has(key)) byViewer.set(key, []);
    byViewer.get(key).push(t);
  }

  const total = { added: 0, updated: 0, newInbound: 0 };
  for (const [viewerFbid, group] of byViewer) {
    if (!viewerFbid) continue;
    const result = await store.ingest(group, viewerFbid);
    total.added += result.added;
    total.updated += result.updated;
    total.newInbound += result.newInbound;
    const viewer = await store.getViewer();
    if (viewer?.fbid !== viewerFbid) await store.setViewer({ fbid: viewerFbid, capturedAt: Date.now() });
  }
  await store.patchHealth({ lastSuccessAt: Date.now(), lastError: null, block: null });
  // Awaited rather than left running: a floating promise in a service worker is
  // one Chrome may kill mid-fetch. Capped at a dozen small images in parallel,
  // and a pass with nothing missing costs one storage read.
  if (faces) await keepFaces().catch(() => {});
  // The cursor rides along with the counts: it belongs to this body, and the
  // backfill needs the one the TOP page handed back to know where to start.
  const cursor = threadListCursor([body]);
  // A body full of conversations that says nothing about a next page is the one
  // failure that reads like success — the inbox looks complete at whatever
  // arrived. Record WHERE this payload keeps its paging, so the next reader is
  // looking at Instagram's real answer instead of guessing at its shape. A list
  // and a single conversation are kept apart: they are different queries with
  // different paging, and one overwriting the other says nothing about either.
  if (!cursor) {
    const key = threads.length > 1 ? 'pagingList' : 'pagingThread';
    await store.patchHealth({ [key]: { at: Date.now(), threads: threads.length, probe: pagingProbe(body) } });
  }
  return { ...total, threads: threads.length, cursor };
}

// ── Faces ─────────────────────────────────────────────────────────────────
//
// The url Instagram gives for a profile picture is signed and expires in days,
// so what gets kept is the picture, not the link. Fetched here rather than from
// the page because host permissions make a worker's cross-origin request plain —
// the CDN has no reason to send us CORS headers, and an <img> we cannot read
// back is an image that dies with its signature.

function base64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // In chunks: spreading a whole buffer into fromCharCode blows the argument
  // limit on anything but a thumbnail.
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

/**
 * Fetch one picture and hand back the small square the list actually draws.
 *
 * The timeout is not politeness. Everything that ingests an inbox response
 * awaits this, so a CDN edge that accepts the connection and never answers
 * stops the refresh, the backfill walking behind it, and the bridge poll
 * waiting on that — with nothing in the log to say why. A picture is worth
 * eight seconds and not one more.
 */
const PICTURE_TIMEOUT_MS = 8000;

async function fetchPicture(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(PICTURE_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  if (blob.size > MAX_SOURCE_BYTES) throw new Error(`${blob.size} bytes is not a profile picture`);

  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(AVATAR_PX, AVATAR_PX);
  // Cropped from the middle, not stretched into the square: Instagram serves
  // squares, but nothing guarantees the one we got is.
  const side = Math.min(bitmap.width, bitmap.height);
  canvas.getContext('2d').drawImage(
    bitmap,
    (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side,
    0, 0, AVATAR_PX, AVATAR_PX,
  );
  bitmap.close();

  const small = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
  return `data:image/jpeg;base64,${base64(await small.arrayBuffer())}`;
}

/**
 * Keep whichever faces are missing or have changed. Never throws at its caller:
 * a picture that doesn't arrive costs a grey initial, and the conversations it
 * belongs to are already stored by the time this runs.
 */
async function keepFaces() {
  const viewer = await store.getViewer();
  const kept = await store.getAvatars();
  const wanted = staleAvatars(await store.listThreads(viewer?.fbid ?? null), kept);
  if (!wanted.length) return;

  const fetched = await Promise.all(wanted.map(async ({ igUserID, id, url }) => {
    try {
      return [igUserID, { id, data: await fetchPicture(url) }];
    } catch {
      // An expired signature, a 403, a body we cannot decode. Remembering the
      // failure is what stops the next capture — seconds away — retrying it.
      return [igUserID, { id, failedAt: Date.now() }];
    }
  }));
  await store.setAvatars({ ...kept, ...Object.fromEntries(fetched) });
}

// ── Tabs ──────────────────────────────────────────────────────────────────

/**
 * The linked tab: one Instagram tab that stays open next to the CRM and is
 * reused for everything — capture, replay, opening a thread, sending. It is
 * adopted rather than duplicated: an Instagram tab the user already had open
 * becomes the linked one. Not pinned — Chrome refuses to put a pinned tab in a
 * tab group, and the workspace group is what keeps it in place now.
 */
async function getLinkedTab() {
  const { [LINK_KEY]: id } = await chrome.storage.session.get(LINK_KEY);
  if (id === undefined) return null;
  try {
    const tab = await chrome.tabs.get(id);
    if (tab?.url?.startsWith('https://www.instagram.com/')) return tab;
  } catch { /* the tab is gone */ }
  await chrome.storage.session.remove(LINK_KEY);
  return null;
}

async function ensureLinkedTab(url = IG_INBOX_URL) {
  const existing = await getLinkedTab();
  if (existing) return existing;

  // The outreach half drives its own Instagram window while a run is going, and
  // that tab looks exactly like a tab worth adopting. Steering it would mean two
  // halves navigating one page mid-send, so it is off limits — `work` is where
  // the run records its window (outreach/src/storage.js).
  const { work } = await chrome.storage.local.get('work');
  const open = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
  const adopted = open.find((tab) => tab.id !== work?.tabId && tab.windowId !== work?.windowId);
  if (adopted?.id !== undefined) {
    await chrome.storage.session.set({ [LINK_KEY]: adopted.id });
    return adopted;
  }
  const created = await chrome.tabs.create({ url, active: false });
  await chrome.storage.session.set({ [LINK_KEY]: created.id });
  return created;
}

/**
 * Wait until the tab has finished loading a url with `marker` in it. Both
 * halves of the condition matter: the url alone arrives before the page does,
 * and `complete` alone can still be the page we navigated away from.
 */
async function settleTab(tabId, marker) {
  for (let i = 0; i < 40; i++) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return null;
    if (tab.status === 'complete' && (tab.url ?? '').includes(marker)) return tab;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/** Point the linked tab at a thread and wait until it is actually there. */
async function openThreadInLinkedTab(threadID) {
  const target = threadURL(threadID);
  const tab = await ensureLinkedTab(target);
  const current = (await chrome.tabs.get(tab.id))?.url ?? '';
  if (!current.includes(`/direct/t/${threadID}`)) {
    await chrome.tabs.update(tab.id, { url: target });
    // Wait for the navigation to finish, otherwise the composer isn't there yet.
    await settleTab(tab.id, `/direct/t/${threadID}`);
    // A page that is merely slow is still worth trying to send into; a tab that
    // went away while we waited is not.
    if (!(await chrome.tabs.get(tab.id).catch(() => null))) return null;
  }
  return tab.id;
}

async function replayInTab(tabId, template) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'replay', template });
  } catch (e) {
    return { status: 0, url: '', body: '', error: String(e?.message ?? e) };
  }
}

/**
 * Send the linked tab to the inbox and let Instagram's own request be the
 * capture. Used when there is no replay template yet, or the stored one died.
 * The tab is left open — it is the linked tab, not a throwaway.
 */
async function captureViaLinkedTab() {
  const tab = await ensureLinkedTab();
  await chrome.tabs.update(tab.id, { url: IG_INBOX_URL });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      awaitingCapture.delete(tab.id);
      resolve({ ok: false, error: 'timeout' });
    }, CAPTURE_TIMEOUT_MS);
    awaitingCapture.set(tab.id, (outcome) => {
      clearTimeout(timer);
      awaitingCapture.delete(tab.id);
      resolve(outcome);
    });
  });
}

// ── Refresh ───────────────────────────────────────────────────────────────

async function refresh() {
  const template = await store.getTemplate();
  // Replaying is just a fetch, so it works from whatever page the linked tab is
  // showing — the user's open thread is never yanked away to the inbox.
  const tab = template ? await getLinkedTab() : null;

  if (template && tab) {
    const res = await replayInTab(tab.id, template);
    // A recognizable thread page is success, checked BEFORE the block classifier:
    // a lead whose message contains "challenge_required" must never park the account.
    if (looksLikeThreads(res?.body)) {
      const counts = await ingestBody(res.body);
      // ONE conversation is not the mailbox. A stored template pointing at a
      // conversation answers every replay with a valid-looking body forever, so
      // the refresh reports success while the inbox never moves again — and no
      // later capture can replace the template, because this path never fails.
      // Whichever way it got stored, this is where it stops being used.
      if (counts.threads > 1) return { ok: true, ...counts };
      await store.setTemplate(null);
    } else {
      const block = classifyInboxBlock(res?.status ?? 0, res?.url ?? '', res?.body ?? '');
      if (block) {
        await store.patchHealth({ block, lastError: block, lastErrorAt: Date.now() });
        // Named, not just reported: what follows a refresh decides whether to
        // keep asking Instagram for things, and "rateLimited" has to be
        // distinguishable from "the tab was slow" by more than the string.
        return { ok: false, error: block, blocked: true };
      }
      // Not a thread page and not a block: the session moved on, so drop the
      // stale template. Only when Instagram actually ANSWERED — a tab that
      // hadn't finished loading yet answers nothing, and throwing away a working
      // template over that would re-open a background tab on every refresh.
      if (res?.status > 0) await store.setTemplate(null);
    }
  }

  const captured = await captureViaLinkedTab();
  if (!captured.ok) {
    await store.patchHealth({ lastError: captured.error, lastErrorAt: Date.now() });
    return { ok: false, error: captured.error };
  }
  return { ok: true, ...captured.counts };
}

// ── Backfill ──────────────────────────────────────────────────────────────
//
// A refresh reads the top of the inbox. This reads the rest of it: by replaying
// Instagram's pagination request with a moving cursor where that request has
// been captured, and by scrolling the list until Instagram issues it where it
// has not (lib/backfill.js).
//
// Paced on purpose. The account this runs on is the one the outreach half sends
// from, so a walk that trips a rate limit costs a send run, not just a listing.

const PAGE_PACE_MS = 900;
const THREAD_PACE_MS = 1200;
const SCROLL_PACE_MS = 1200;

/**
 * Direction is judged against the THREAD api's viewer id (an IG pk), which is a
 * different number from the inbox payload's messaging fbid — resolving it
 * anywhere else would silently flip who said what.
 */
const messagesFrom = (page) => page.messages.map((m) => ({
  id: m.id,
  direction: m.senderFbid && m.senderFbid === page.viewerID ? 'out' : 'in',
  text: m.text,
  timestamp: m.timestampMs,
}));

/** Conversations whose history is missing, or older than their last message. */
const needsHistory = (row) =>
  row.replied === true && (!row.historyAt || row.historyOlder === true || (row.lastActivityAt ?? 0) > row.historyAt);

/**
 * The inbox list carries a message or two per conversation. This fetches the
 * rest of them, for the conversations that have a reply in them — the ones
 * where there is something to read.
 *
 * One fetch per thread, replayed through the linked tab rather than navigating
 * it: a hundred navigations is a hundred chances for Instagram's own client to
 * be slow, hidden, or throttled.
 */
async function historyPass(tabId, viewerFbid) {
  const wanted = (await store.listThreads(viewerFbid)).filter(needsHistory);
  if (!wanted.length) return { threads: 0, added: 0, stopped: 'exhausted' };

  let template = await store.getThreadTemplate();
  // Nothing has opened a conversation in a hooked tab yet, so there is no
  // request to point elsewhere. Opening one is how we get it — Instagram
  // fetches the history itself and the hook keeps the request.
  if (!template?.url) {
    await openThreadInLinkedTab(wanted[0].threadID);
    template = await store.getThreadTemplate();
    if (!template?.url) return { threads: 0, added: 0, stopped: 'no-thread-template' };
  }

  // Two dialects, and the request is built differently in each: the GraphQL
  // query names its conversation in the variables, the old REST one in the url.
  const requestFor = (threadID, cursor) => {
    if (typeof template.body === 'string') {
      const body = swapThreadVariables(template.body, threadID, cursor);
      return body ? { url: template.url, headers: template.headers ?? {}, body } : null;
    }
    const url = swapThreadURL(template.url, threadID, cursor);
    return url ? { url, headers: template.headers ?? {} } : null;
  };
  if (!requestFor(wanted[0].threadID, null)) {
    // Grinding through a hundred conversations to fail identically on each is
    // not thoroughness. The template cannot be retargeted; say so once.
    return { threads: 0, added: 0, stopped: 'bad-thread-template' };
  }

  let threads = 0;
  let added = 0;
  // Why each conversation ended, counted. Without it a pass that answered
  // "nothing older here" 131 times is indistinguishable from one that failed
  // 131 times — both report zero new messages.
  const stops = {};
  for (const row of wanted) {
    const result = await walkThread({
      paceMs: THREAD_PACE_MS,
      page: (cursor) => {
        const request = requestFor(row.threadID, cursor);
        if (!request) return { status: 0, url: '', body: '' };
        return replayInTab(tabId, request);
      },
      ingest: (page) => store.ingestMessages(viewerFbid, row.threadID, messagesFrom(page)),
    });
    threads += 1;
    added += result.added;
    stops[result.stopped] = (stops[result.stopped] ?? 0) + 1;
    await store.noteHistory(viewerFbid, row.threadID, { at: Date.now(), hasOlder: result.hasMore });
    await store.patchHealth({ history: { threads, total: wanted.length, added, stops, running: true, at: Date.now() } });
    // A block is about the account, not this conversation: the next thread
    // would hit the same wall, harder.
    if (result.stopped.startsWith('block:')) {
      return { threads, added, stops, stopped: result.stopped };
    }
  }
  return { threads, added, stops, stopped: 'exhausted' };
}

async function walkList() {
  const saved = (await store.getHealth()).backfill ?? null;
  // Resume where the last walk stopped. Starting over would re-read hundreds of
  // pages to reach the same place — and the top of the inbox is what `refresh`
  // is for.
  let cursor = saved?.hasMore ? saved.cursor : null;
  const opening = { added: 0, updated: 0, newInbound: 0 };

  if (!cursor) {
    const top = await refresh();
    if (!top.ok) return { ok: false, error: top.error, blocked: top.blocked === true };
    opening.added += top.added ?? 0;
    opening.updated += top.updated ?? 0;
    opening.newInbound += top.newInbound ?? 0;
    // A top page that reports no next page is a finished inbox — but only when it
    // actually spoke about paging. Silence there is handled below, where the
    // captured next-page request can still say where to start.
    if (top.cursor?.hasNext === true) cursor = top.cursor.end;
    else if (top.cursor) {
      await store.patchHealth({ backfill: { pages: 0, cursor: null, hasMore: false, stopped: 'exhausted', at: Date.now() } });
      return { ok: true, ...opening, pages: 0, stopped: 'exhausted' };
    }
  }

  // Adopted rather than merely looked up: the link lives in session storage, so
  // reloading the extension loses it while the Instagram tab is still sitting
  // there. Looking it up would end the walk as "no tab" over a lost id.
  const tab = await ensureLinkedTab();

  // The pagination request is a different query from the one that fetches the
  // top of the inbox, and it is only captured once Instagram has scrolled the
  // list itself. Without it, the top-page template with a cursor spliced in is
  // worth one attempt — the walk checks the answer and stops if it is not a page.
  const pageTemplate = (await store.getPageTemplate()) ?? (await store.getTemplate());
  // The captured next-page request carries the position it was asking for. It is
  // not the top of the list, but it IS a real place in it — worth walking from
  // when the top page answers in a dialect whose cursor this query will not take.
  if (!cursor) cursor = requestVariables(pageTemplate?.body)?.cursor ?? null;
  if (!cursor) {
    await store.patchHealth({ backfill: { pages: 0, cursor: null, hasMore: true, stopped: 'no-cursor', at: Date.now() } });
    return { ok: true, ...opening, pages: 0, stopped: 'no-cursor' };
  }
  await store.patchHealth({ backfill: { ...(saved ?? {}), running: true, cursor, hasMore: true, at: Date.now() } });

  let described = false;
  const result = await walkInbox({
    pageTemplate,
    cursor,
    paceMs: PAGE_PACE_MS,
    replay: (template) => replayInTab(tab.id, template),
    ingest: (page) => {
      // The first page a walk pulls, described once. `onStuck` fires only when
      // the walk notices it is going nowhere, and a walk that goes nowhere
      // QUIETLY — same page, new cursor — never reaches it.
      if (!described) {
        described = true;
        store.patchHealth({ pagingList: { at: Date.now(), walk: true, probe: pagingProbe(page) } }).catch(() => {});
      }
      return ingestBody(page, { faces: false });
    },
    onPage: (state) => store.patchHealth({ backfill: { ...state, running: true, at: Date.now() } }),
    onStuck: (body) => store.patchHealth({ pagingList: { at: Date.now(), stuck: true, probe: pagingProbe(body) } }),
  });
  // The pictures the walk skipped, in one pass rather than one per page.
  await keepFaces().catch(() => {});

  await store.patchHealth({
    backfill: {
      pages: result.pages, cursor: result.cursor, hasMore: result.hasMore,
      stopped: result.stopped, running: false, at: Date.now(),
    },
  });
  if (result.stopped.startsWith('block:')) {
    const block = result.stopped.slice('block:'.length);
    await store.patchHealth({ block, lastError: block, lastErrorAt: Date.now() });
  }
  return {
    ok: true,
    pages: result.pages,
    stopped: result.stopped,
    hasMore: result.hasMore,
    added: result.added + opening.added,
    updated: result.updated + opening.updated,
    newInbound: result.newInbound + opening.newInbound,
  };
}

/**
 * One real wheel tick where the list is, through the session already attached
 * for focus emulation. Returns why it failed, or null — swallowed, it would
 * leave a pass that scrolls and finds nothing with no way to tell which half
 * stopped working.
 *
 * Not reusing outreach/src/cdp.js for this, deliberately: that module keeps ONE
 * attached tab in a module-level variable, shared with a send run, and pointing
 * it at the CRM's tab mid-run would send the next lead's message into this tab.
 */
async function wheelAt(tabId, x, y) {
  const at = { x: Math.round(x), y: Math.round(y) };
  try {
    // The pointer has to be over the list first — a wheel goes to whatever is
    // under it, and Chrome puts it at 0,0 until something moves it.
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent',
      { type: 'mouseMoved', ...at, button: 'none', buttons: 0 });
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent',
      { type: 'mouseWheel', ...at, deltaX: 0, deltaY: 240, pointerType: 'mouse' });
    return null;
  } catch (e) {
    return String(e?.message ?? e);
  }
}

/**
 * The rest of the list, by making Instagram page it itself.
 *
 * Replaying the pagination request needs that request to have been captured,
 * and it is only ever issued by Instagram's own virtual list. So this scrolls
 * the linked tab's list to the bottom, over and over, and the hook stores what
 * Instagram fetches — which is also how the pagination request finally gets
 * captured, making the faster walk possible next time.
 */
async function scrollPass() {
  const tab = await ensureLinkedTab();
  // The inbox, even though a thread page carries the same list down its side.
  // Focus emulation below tells the page it is visible and focused, and an open
  // conversation in that state is one Instagram marks as read — a scroll through
  // the list must not put "seen" on somebody's message. The inbox has no open
  // conversation to mark, and only one thing on it that scrolls.
  const current = (await chrome.tabs.get(tab.id).catch(() => null))?.url ?? '';
  if (!current.includes('/direct/inbox')) await chrome.tabs.update(tab.id, { url: IG_INBOX_URL });
  const settled = await settleTab(tab.id, '/direct/inbox');
  if (!settled) return { ok: false, stopped: 'no-inbox' };

  // The tab has to be the one its window is SHOWING. A background tab is not
  // merely occluded — Chrome does not paint it at all, and focus emulation does
  // not bring that back: it answers the question "is this window in front",
  // which is a different question. No frames, no IntersectionObserver, no next
  // chunk — a pass that scrolls perfectly and collects nothing. Put back
  // afterwards, so Load all does not leave the user staring at Instagram.
  const showing = (await chrome.tabs.query({ windowId: settled.windowId, active: true }))[0]?.id ?? null;
  if (!settled.active) await chrome.tabs.update(tab.id, { active: true }).catch(() => {});

  // And the window has to be rendering at all. One fully covered, or on another
  // macOS Space, is occluded and Chrome stops producing frames for it — which
  // takes the rendering step, and IntersectionObserver with it. That is what
  // focus emulation is for, and it needs a debugger session
  // (outreach/src/cdp.js keepRendering says what it costs and what it measured).
  let frames = { on: false };
  try {
    await chrome.debugger.attach({ tabId: tab.id }, '1.3');
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    frames = { on: true };
  } catch (e) {
    // Usually the outreach half holding this tab's session mid-run. Recorded
    // rather than fatal: a tab that is actually on screen renders anyway — and
    // if it is not, this line is why the pass found nothing.
    frames = { on: false, error: String(e?.message ?? e) };
  }

  // A tab reports `complete` before Instagram has drawn the list, so the first
  // scroll can land on a page with nothing on it yet — and a walk that stops on
  // `no-rows` costs the whole run. Asking until there is something to scroll is
  // the same request the walk makes, so a wasted try costs one scroll.
  for (let i = 0; i < 12 && !(await ask(tab.id, { type: 'scroll-list' }))?.ok; i++) {
    await new Promise((r) => setTimeout(r, 500));
  }

  const viewer = await store.getViewer();
  const note = (state) => store.patchHealth({ scroll: { ...state, frames, at: Date.now() } });
  await note({ rounds: 0, running: true });

  try {
    const result = await scrollInbox({
      paceMs: SCROLL_PACE_MS,
      // Instagram fetches, parses and renders a chunk before the count moves, so
      // patience is measured in seconds, not rounds. Four was thin enough to end
      // a working pass on a slow answer.
      quietRounds: 6,
      scroll: async () => {
        const view = await ask(tab.id, { type: 'scroll-list' });
        // The jump above lands at the bottom of what is loaded; this is the
        // flick a hand would end on. Only with a session — without one the page
        // is not rendering anyway, and there is nothing to send a wheel to.
        if (view?.ok && frames.on) view.wheel = await wheelAt(tab.id, view.x, view.y);
        return view;
      },
      count: async () => (await store.listThreads(viewer?.fbid ?? null)).length,
      onRound: (state) => note({ ...state, running: true }),
    });
    // A pass that brought nothing is the one worth describing: scrolling the
    // wrong thing and reaching the end of the inbox look identical from here,
    // and the page itself is the only thing that can tell them apart.
    const probe = result.gained > 0 ? null : await ask(tab.id, { type: 'scroll-probe' });
    await note({ ...result, ...(probe ? { probe } : {}), running: false });
    return { ok: true, ...result };
  } finally {
    if (frames.on) await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
    if (showing && showing !== tab.id) await chrome.tabs.update(showing, { active: true }).catch(() => {});
  }
}

/** The whole inbox: every conversation, then the history of the live ones. */
async function backfill() {
  const list = await walkList();

  // The walk is the cheaper way and it only works when Instagram's pagination
  // request has been captured, which the scroll is what brings about. Skipped
  // once the walk has read the list to its end — scrolling to the bottom of a
  // list we have all of is a few hundred requests for nothing.
  //
  // Read to its end means PAGES were read. A walk that stopped at `exhausted`
  // without paging once only ever saw the top page, and the query that fetches
  // it is a mailbox snapshot: it does not offer a next page because it does not
  // have the concept, not because the inbox ended there. Believing it is how
  // "we have everything" gets reported over a fifth of the inbox.
  //
  // A walk that could not run at all is not a reason to skip the scroll either:
  // it needs a captured request and the scroll needs nothing but the tab.
  const walked = list.stopped === 'exhausted' && (list.pages ?? 0) > 0;
  // What THIS run ran into. `health.block` would be the easier thing to read and
  // the wrong one: it stands until something succeeds, so a walk that makes no
  // request at all — the usual case, there is nothing to replay yet — leaves
  // yesterday's block standing and the scroll would never run again.
  const blocked = list.blocked === true || list.stopped?.startsWith('block:') === true;
  const scrolled = walked || blocked ? null : await scrollPass();
  // Either pass reaching the inbox is a run that did something. Only both
  // failing is a failure the user has to hear about.
  const ok = list.ok || scrolled?.ok === true;

  const viewer = await store.getViewer();
  const tab = await getLinkedTab();
  // A block during the list pass is about the account, so the hundred requests
  // the history pass would make next are exactly the wrong answer to it.
  if (!viewer?.fbid || !tab || blocked) return { ...list, ok, scroll: scrolled };

  const history = await historyPass(tab.id, viewer.fbid);
  await store.patchHealth({ history: { ...history, running: false, at: Date.now() } });
  if (history.stopped.startsWith('block:')) {
    const block = history.stopped.slice('block:'.length);
    await store.patchHealth({ block, lastError: block, lastErrorAt: Date.now() });
  }
  return { ...list, ok, scroll: scrolled, history };
}

// ── Replying ──────────────────────────────────────────────────────────────

/** Ask the linked tab something. A tab with no content script is an answer too. */
const ask = (tabId, message) =>
  chrome.tabs.sendMessage(tabId, message).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));

/**
 * A reply in three parts, split by what each side is able to do: the page finds
 * and focuses the composer, the debugger types and presses Enter — only trusted
 * input submits (crm/trusted-input.js) — and the page says whether the message
 * actually left.
 */
async function sendReply(tabId, text) {
  const ready = await ask(tabId, { type: 'focus-composer' });
  if (!ready?.ok) return ready ?? { ok: false, error: 'no-response' };

  const typed = await insertAndSend(tabId, text);
  if (!typed.ok) return typed;

  const sent = await ask(tabId, { type: 'confirm-sent' });
  // Deliberately not awaited: the message is already gone and the CRM is holding
  // its reply box on this answer. If the worker dies before the capture lands,
  // the linked tab is standing in the thread and Instagram's own fetch of it
  // brings the message back through the hook anyway.
  if (sent?.ok) refresh().catch(() => {});
  return sent ?? { ok: false, error: 'no-response' };
}

// ── Messages ──────────────────────────────────────────────────────────────

async function handle(message, sender) {
  switch (message?.type) {
    case 'ig-capture': {
      if (message.kind === 'page-template') {
        if (message.template) {
          await store.setPageTemplate({ ...message.template, capturedAt: Date.now() });
          await store.patchHealth({ varsPage: variableKeys(message.template.body) });
        }
        return { ok: true };
      }
      if (message.kind === 'thread') {
        // Instagram fetched a thread's history because the linked tab opened it.
        // Direction here is judged against the THREAD api's viewer id (an IG pk),
        // which is a different number from the inbox payload's messaging fbid.
        // Keep the request itself: pointed at another thread id it fetches that
        // conversation without steering the tab into it, which is what turns a
        // history backfill from hundreds of navigations into hundreds of fetches.
        if (message.template) {
          await store.setThreadTemplate({ ...message.template, capturedAt: Date.now() });
          await store.patchHealth({ varsThread: variableKeys(message.template.body) });
        }
        const threadID = threadIDFromURL(message.url);
        // GraphQL dialect: a conversation answers in the same shape as a mailbox
        // page holding one thread, so the inbox reader is the one that
        // understands it, and the thread id lives in the request, not the url.
        if (!threadID) {
          const counts = await ingestBody(message.body ?? '');
          return { ok: true, ...counts };
        }
        const page = parseThreadPage(message.body ?? '');
        if (!page) return { ok: true };
        const viewer = await store.getViewer();
        if (!viewer?.fbid) return { ok: true };
        // The only place the logged-in account is named rather than numbered.
        // Worth keeping: it is what the header and the bridge call this CRM.
        if (page.viewerUsername && viewer.username !== page.viewerUsername) {
          await store.setViewer({ ...viewer, username: page.viewerUsername });
        }
        const result = await store.ingestMessages(viewer.fbid, threadID, messagesFrom(page));
        // Opening a conversation is the second place Instagram describes the
        // person, and the inbox list does not always carry a picture. A changed
        // one is fetched here too — its url has just been reissued, so this is
        // the moment it is fetchable.
        if (page.lead && (await store.noteIdentity(viewer.fbid, threadID, page.lead)).changed) {
          await keepFaces().catch(() => {});
        }
        return { ok: true, ...result };
      }
      if (message.kind === 'seen') {
        // A tally of query names, so the two things the extension keys on — how
        // the next inbox page is asked for, and how a conversation's history
        // arrives — can be read off real traffic instead of assumed.
        const health = await store.getHealth();
        const queries = { ...(health.queries ?? {}) };
        const name = String(message.name || '(unnamed)').slice(0, 60);
        const seen = queries[name] ?? { n: 0, threads: 0, bytes: 0 };
        queries[name] = {
          n: seen.n + 1,
          threads: seen.threads + (message.threads ? 1 : 0),
          bytes: Math.max(seen.bytes, Number(message.bytes) || 0),
        };
        if (Object.keys(queries).length <= 40) await store.patchHealth({ queries });
        return { ok: true };
      }
      if (message.kind !== 'inbox') return { ok: true };
      const counts = await ingestBody(message.body ?? '');
      // The refresh template may only come from an answer that carried a LIST.
      // One thread in it means a conversation wearing the mailbox's markers, and
      // keeping its request would make every later refresh re-read that one
      // conversation and call it a successful refresh. An inbox with a single
      // conversation in it loses nothing: there is no second page to ask for.
      if (message.template && counts.threads > 1) {
        const stamped = { ...message.template, capturedAt: Date.now() };
        const vars = requestVariables(message.template.body) ?? {};
        // Loading the inbox produces more than one query that answers with a
        // list, and only one of them takes a cursor. Kept apart by that, not by
        // name: the other one is a mailbox snapshot, and walking it means asking
        // for the same page until something notices.
        if (canPaginate(message.template.body)) {
          await store.setPageTemplate(stamped);
          await store.patchHealth({ varsPage: Object.keys(vars) });
        }
        // A request already carrying a cursor points into the middle of the
        // list; as the refresh template it would re-read that slice forever.
        if (!vars.cursor) {
          await store.setTemplate(stamped);
          await store.patchHealth({ varsInbox: Object.keys(vars) });
        }
      }
      const waiter = sender?.tab?.id !== undefined ? awaitingCapture.get(sender.tab.id) : null;
      // Only a LIST ends the wait. Loading the inbox also produces single-thread
      // mailbox updates — a message arriving, a thread being marked read — and
      // they carry the mailbox's markers. Taking the first one as "the inbox
      // arrived" hands the caller one conversation and calls it the first page,
      // which reads as an inbox with no next page at all.
      if (waiter && counts.threads > 1) waiter({ ok: true, counts });
      return { ok: true, ...counts };
    }
    case 'crm-state': {
      const viewer = await store.getViewer();
      return {
        viewer,
        health: await store.getHealth(),
        threads: await store.listThreads(viewer?.fbid ?? null),
        hasTemplate: Boolean(await store.getTemplate()),
      };
    }
    case 'crm-messages': {
      const viewer = await store.getViewer();
      return store.messages(viewer?.fbid ?? '', message.threadID);
    }
    case 'crm-refresh':
      return refresh();
    case 'crm-backfill':
      return backfill();
    case 'crm-select': {
      // The linked tab follows the CRM. Opening the thread also makes Instagram
      // fetch its full history, which the hook captures — that is how the
      // conversation fills in.
      const tabId = await openThreadInLinkedTab(message.threadID);
      return { ok: tabId !== null };
    }
    case 'crm-send': {
      const text = String(message.text ?? '').trim();
      if (!text) return { ok: false, error: 'empty' };
      const tabId = await openThreadInLinkedTab(message.threadID);
      if (tabId === null) return { ok: false, error: 'no-tab' };
      // Instagram's own copy of the message (real id, real timestamp) comes back
      // with the next capture rather than being faked locally.
      return sendReply(tabId, text);
    }
    case 'crm-linked-tab': {
      if (message.open) {
        const tab = await ensureLinkedTab();
        await chrome.tabs.update(tab.id, { active: true });
        return { linked: true };
      }
      return { linked: Boolean(await getLinkedTab()) };
    }
    case 'crm-patch': {
      // Stage / note / tags from the bridge. The store decides which keys are
      // allowed — a command must not be able to rewrite what Instagram said.
      const viewer = await store.getViewer();
      const result = await store.patchThread(viewer?.fbid ?? '', message.threadID, message.fields);
      return { ok: true, ...result };
    }
    case 'crm-patch-many': {
      // The same field onto a picked set of rows. One store pass, so the page
      // repaints once rather than once per row.
      const viewer = await store.getViewer();
      const result = await store.patchThreads(viewer?.fbid ?? '', message.threadIDs, message.fields);
      return { ok: true, ...result };
    }
    case 'crm-mark-read': {
      const viewer = await store.getViewer();
      await store.markReadMany(viewer?.fbid ?? '', message.threadIDs);
      return { ok: true };
    }
    case 'crm-open-instagram':
      await chrome.tabs.create({ url: IG_INBOX_URL, active: true });
      return { ok: true };
    default:
      return { ok: false, error: 'unknown message' };
  }
}

/** The outreach worker shares this service worker, and its protocol is its own. */
const mine = (type) => type === 'ig-capture' || (typeof type === 'string' && type.startsWith('crm-'));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Answering someone else's message with "unknown message" would beat their own
  // handler to the reply.
  if (!mine(message?.type)) return false;
  handle(message, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
  return true; // responses are async
});

// The user closed the background tab before it produced anything — a failed
// refresh, not a silent "nothing new".
chrome.tabs.onRemoved.addListener((tabId) => {
  const waiter = awaitingCapture.get(tabId);
  if (waiter) { awaitingCapture.delete(tabId); waiter({ ok: false, error: 'tab-closed' }); }
});

// The toolbar icon opens the whole workspace, not just this page — ../workspace.js.
