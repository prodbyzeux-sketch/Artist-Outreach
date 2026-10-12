// inbox.js — turning Instagram's own inbox traffic into "did they reply?".
//
// Nothing here asks Instagram for anything. The work window is standing in
// Direct anyway, so the service worker records the `/api/graphql` responses the
// page already fetched and hands the bodies to this file. Same discipline as
// the input layer: only what a person's browser did on its own.
//
// Ported from the Tabels engine's InboxGraphQLParser, including the two
// findings that cost real debugging there:
//
//   · Parse by SHAPE, not by query name — walk any object carrying
//     `slide_messages` plus a thread id, wherever it sits. Instagram renames
//     and re-nests its queries; the shape has held.
//   · Direction compares against the viewer's MESSAGING fbid
//     (`viewer.interop_messaging_user_fbid`), never `viewer_id` (the IG pk).
//     A snippet's `sender_fbid` is a messaging fbid, so comparing it to the pk
//     reads our OWN sends as inbound and every reply rate comes out inflated.
//
// Pure — no chrome APIs, no DOM. Everything here is unit-testable.

// One JSON body, or Relay's streaming form of one object per line.
function jsonObjects(body) {
  try {
    return [JSON.parse(body)];
  } catch (_e) { /* fall through to the streaming form */ }
  const out = [];
  for (const line of body.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch (_e) { /* not every line is JSON */ }
  }
  return out;
}

// IG sends pk/id as a string in some payloads and a number in others.
const pkStr = (v) => (v == null ? "" : String(v));

function collectThreads(node, into) {
  if (Array.isArray(node)) {
    for (const v of node) collectThreads(v, into);
    return;
  }
  if (!node || typeof node !== "object") return;
  if (node.slide_messages != null && (node.thread_id != null || node.thread_key != null)) into.push(node);
  for (const key of Object.keys(node)) collectThreads(node[key], into);
}

const ms = (v) => {
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
};

function parseThread(d) {
  const threadId = pkStr(d.thread_id || d.thread_key);
  if (!threadId) return null;

  // See the header: the messaging fbid, with viewer_id only as a fallback.
  const viewerId = pkStr(d.viewer?.interop_messaging_user_fbid) || pkStr(d.viewer_id);

  let username = "";
  const other = Array.isArray(d.usersWithoutViewer) ? d.usersWithoutViewer[0] : null;
  if (other) username = other.username || "";
  if (!username && Array.isArray(d.users)) {
    for (const u of d.users) {
      if (pkStr(u.pk ?? u.id) !== viewerId && u.username) { username = u.username; break; }
    }
  }

  const messages = [];
  const edges = d.slide_messages?.edges;
  if (Array.isArray(edges)) {
    for (const e of edges) {
      const node = e?.node;
      const id = node?.id;
      if (!id) continue;
      messages.push({
        id,
        senderFbid: pkStr(node.sender_fbid),
        timestampMs: ms(node.timestamp_ms),
      });
    }
  }

  return {
    threadId,
    username: username.toLowerCase(),
    viewerId,
    lastActivityMs: ms(d.last_activity_timestamp_ms),
    messages,
  };
}

// Every thread across every captured body, merged by id — one capture pass can
// see the same thread in several payloads.
export function parseInboxBodies(bodies) {
  const byId = new Map();
  for (const body of bodies) {
    for (const root of jsonObjects(body)) {
      const dicts = [];
      collectThreads(root, dicts);
      for (const d of dicts) {
        const t = parseThread(d);
        if (!t) continue;
        const ex = byId.get(t.threadId);
        if (!ex) { byId.set(t.threadId, t); continue; }
        const seen = new Set(ex.messages.map((m) => m.id));
        for (const m of t.messages) if (!seen.has(m.id)) { ex.messages.push(m); seen.add(m.id); }
        ex.lastActivityMs = Math.max(ex.lastActivityMs, t.lastActivityMs);
        if (!ex.username) ex.username = t.username;
        if (!ex.viewerId) ex.viewerId = t.viewerId;
      }
    }
  }
  return [...byId.values()];
}

// ── does a conversation with this person exist? ───────────────────────────────
// Opening a chat makes Instagram fetch that thread, and its answer settles the
// question outright — no counting bubbles on screen. Three answers, all read off
// live traffic, weakest first:
//
//   · Instagram looked the person up by their messaging fbid
//     (`xig_user_from_messaging_user_fbid`) next to a `get_slide_thread_nullable:
//     null` — it resolves a profile that way precisely because there is no
//     thread to render. No conversation.
//   · a thread record without its messages — Direct's search route fetches only
//     the metadata, so the thread's existence is the whole answer.
//   · a thread carrying `slide_messages` — the Message button on a profile asks
//     for those, and an empty edge list is a chat that was never used.
//
// Silence is not a "no": re-opening a thread the page has already shown fetches
// nothing at all, so a username missing from the result means unknown.
function collectSaid(node, out) {
  if (Array.isArray(node)) {
    for (const v of node) collectSaid(v, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const named = Array.isArray(node.users) || Array.isArray(node.usersWithoutViewer);
  if ((node.thread_key != null || node.thread_id != null) && named) out.threads.push(node);
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (key === "get_slide_thread_nullable" && v === null) out.noThread++;
    if (key === "xig_user_from_messaging_user_fbid" && v && v.username) out.lookups.push(v);
    collectSaid(v, out);
  }
}

// Everyone in the thread except us. Both lists are read, never one or the
// other: the inbox's own payload carries an EMPTY `usersWithoutViewer` next to a
// filled `users`, and preferring the first name-shaped list there lost every
// thread in the inbox (measured on live traffic, 15 of 15).
function otherUsernames(thread) {
  const viewerId = pkStr(thread.viewer?.interop_messaging_user_fbid) || pkStr(thread.viewer_id);
  const names = new Set();
  for (const u of [...(thread.usersWithoutViewer ?? []), ...(thread.users ?? [])]) {
    if (!u || !u.username) continue;
    if (viewerId && (pkStr(u.interop_messaging_user_fbid) === viewerId || pkStr(u.pk ?? u.id) === viewerId)) continue;
    names.add(u.username.toLowerCase());
  }
  return names;
}

// username → { exists, messages }, where `messages` is null when the payload
// carried the thread but not its contents.
export function readConversations(bodies) {
  const said = {};
  const found = { threads: [], lookups: [], noThread: 0 };
  for (const body of bodies) for (const root of jsonObjects(body)) collectSaid(root, found);

  if (found.noThread) {
    for (const u of found.lookups) said[u.username.toLowerCase()] = { exists: false, messages: 0 };
  }
  for (const t of found.threads) {
    if (t.slide_messages?.edges) continue;
    for (const name of otherUsernames(t)) said[name] = { exists: true, messages: null };
  }
  const counted = new Map();
  for (const t of found.threads) {
    const edges = t.slide_messages?.edges;
    if (!Array.isArray(edges)) continue;
    // Payloads arrive a page at a time; the fullest one wins.
    for (const name of otherUsernames(t)) counted.set(name, Math.max(counted.get(name) ?? 0, edges.length));
  }
  for (const [name, messages] of counted) said[name] = { exists: messages > 0, messages };
  return said;
}

// What the dashboard actually needs, which is far less than the conversation.
// Storing derived facts instead of message text keeps the extension from
// hoarding people's DMs to draw a percentage.
export function threadFacts(thread) {
  const msgs = [...thread.messages].sort((a, b) => a.timestampMs - b.timestampMs);
  const isOurs = (m) => !!thread.viewerId && m.senderFbid === thread.viewerId;

  const firstOut = msgs.find(isOurs);
  // Replied = an inbound AFTER our first outbound. A thread where they wrote
  // first and never answered our opener is not a reply.
  const firstReply = firstOut
    ? msgs.find((m) => !isOurs(m) && m.timestampMs > firstOut.timestampMs)
    : null;

  return {
    threadId: thread.threadId,
    username: thread.username,
    lastActivityMs: thread.lastActivityMs,
    firstOutMs: firstOut ? firstOut.timestampMs : 0,
    firstReplyMs: firstReply ? firstReply.timestampMs : 0,
    replied: !!firstReply,
    outCount: msgs.filter(isOurs).length,
    inCount: msgs.filter((m) => !isOurs(m)).length,
  };
}

// Fold a capture pass into what we already knew. A pass only ever sees a slice
// of a conversation, so facts move forward and never backward: the earliest
// outbound and the earliest qualifying reply win.
export function mergeFacts(store, threads) {
  const next = { ...store };
  for (const t of threads) {
    const f = threadFacts(t);
    const ex = next[f.threadId];
    if (!ex) { next[f.threadId] = f; continue; }
    const firstOutMs = Math.min(ex.firstOutMs || Infinity, f.firstOutMs || Infinity);
    const firstReplyMs = Math.min(ex.firstReplyMs || Infinity, f.firstReplyMs || Infinity);
    next[f.threadId] = {
      ...ex,
      username: f.username || ex.username,
      lastActivityMs: Math.max(ex.lastActivityMs, f.lastActivityMs),
      firstOutMs: Number.isFinite(firstOutMs) ? firstOutMs : 0,
      firstReplyMs: Number.isFinite(firstReplyMs) ? firstReplyMs : 0,
      replied: ex.replied || f.replied,
      outCount: Math.max(ex.outCount, f.outCount),
      inCount: Math.max(ex.inCount, f.inCount),
    };
  }
  return next;
}

// Instagram pushing back on the capture. Same two signals Tabels backs off on:
// hammering a rate-limited or challenged session is how an account gets parked.
export function blockSignal(statuses) {
  if (statuses.includes(429)) return "rateLimited";
  if (statuses.includes(401) || statuses.includes(403)) return "challenge";
  return null;
}
