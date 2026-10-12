// Pure parsing of Instagram's own inbox responses. Ported from siluet's
// InboxGraphQLParser / InboxThreadParser (App.swift:3419-3656) — same tolerance
// rules: find threads by SHAPE, never by query name, so a renamed or renested
// query keeps working. No chrome.*, no DOM: this file is unit-testable in node
// and is deliberately never loaded into the Instagram page.

/** IG sends `pk`/`id`/`sender_fbid` as a string OR a number. One stable string. */
function pkStr(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return '';
}

function ms(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  return 0;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** One body is either a JSON object, or a Relay stream: one JSON object per line. */
function jsonObjects(body) {
  if (typeof body !== 'string' || body === '') return [];
  try { return [JSON.parse(body)]; } catch { /* fall through to the line reader */ }
  const out = [];
  for (const line of body.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* a partial chunk — skip it */ }
  }
  return out;
}

function collectThreads(node, into) {
  if (isObject(node)) {
    if (node.slide_messages !== undefined && (node.thread_id !== undefined || node.thread_key !== undefined)) {
      into.push(node);
    }
    for (const v of Object.values(node)) collectThreads(v, into);
  } else if (Array.isArray(node)) {
    for (const v of node) collectThreads(v, into);
  }
}

// A message with no text is an attachment, and IG hands us the sentence its own
// inbox prints for it ("You sent an attachment.", "akku sent a photo."). That is
// UI copy about the message, not the message: shown verbatim it reads as an
// English line the operator typed. Anchored at the end, so a snippet that merely
// mentions attachments stays untouched — and unmatched wording (another IG
// locale) falls through to the snippet, which is where we were before.
const SNIPPET_PREVIEW = /\bsent an? (attachment|photo|video|voice message)\.?$/i;
const PREVIEW_MARKERS = { attachment: '[media]', photo: '[media]', video: '[media]', 'voice message': '[voice]' };

/**
 * The marker for one of those preview lines, or null for anything else. Exported
 * because messages captured before this existed are stored with the English
 * sentence in them, and the CRM reads them through here rather than migrating
 * the store.
 */
export function snippetMarker(text) {
  const preview = SNIPPET_PREVIEW.exec(String(text ?? ''));
  return preview ? PREVIEW_MARKERS[preview[1].toLowerCase()] : null;
}

function messageText(node) {
  if (typeof node.text_body === 'string' && node.text_body) return node.text_body;
  if (isObject(node.content) && typeof node.content.text_body === 'string' && node.content.text_body) {
    return node.content.text_body;
  }
  if (typeof node.igd_snippet === 'string' && node.igd_snippet) return snippetMarker(node.igd_snippet) ?? node.igd_snippet;
  return '';
}

function parseThread(d) {
  const threadID = pkStr(d.thread_id) || pkStr(d.thread_key);
  if (!threadID) return null;

  // A snippet's `sender_fbid` is the MESSAGING fbid, not the IG pk, so direction
  // must compare against `viewer.interop_messaging_user_fbid`. Comparing against
  // `viewer_id` reads the operator's own sends as inbound and turns the whole
  // inbox unread (siluet hit exactly this).
  const viewerFbid = isObject(d.viewer) ? pkStr(d.viewer.interop_messaging_user_fbid) : '';
  const viewerID = viewerFbid || pkStr(d.viewer_id);

  let username = '', displayName = '', avatarURL = '', igUserID = '';
  const first = Array.isArray(d.usersWithoutViewer) ? d.usersWithoutViewer[0] : null;
  if (isObject(first)) {
    username = typeof first.username === 'string' ? first.username : '';
    displayName = typeof first.full_name === 'string' ? first.full_name : '';
    avatarURL = typeof first.profile_pic_url === 'string' ? first.profile_pic_url : '';
    igUserID = pkStr(first.pk ?? first.id);
  }
  if ((!username || !igUserID) && Array.isArray(d.users)) {
    for (const u of d.users) {
      if (!isObject(u) || typeof u.username !== 'string') continue;
      const uid = pkStr(u.pk ?? u.id);
      if (uid === viewerID) continue;
      if (!username) {
        username = u.username;
        displayName = typeof u.full_name === 'string' ? u.full_name : '';
        avatarURL = typeof u.profile_pic_url === 'string' ? u.profile_pic_url : '';
      }
      if (!igUserID) igUserID = uid;
      break;
    }
  }

  const messages = [];
  const edges = isObject(d.slide_messages) && Array.isArray(d.slide_messages.edges) ? d.slide_messages.edges : [];
  for (const e of edges) {
    const node = isObject(e) && isObject(e.node) ? e.node : null;
    if (!node) continue;
    const id = pkStr(node.id);
    if (!id) continue;
    messages.push({
      id,
      senderFbid: pkStr(node.sender_fbid),
      timestampMs: ms(node.timestamp_ms),
      text: messageText(node),
    });
  }

  return {
    threadID,
    lastActivityMs: ms(d.last_activity_timestamp_ms),
    username, displayName, avatarURL, igUserID, viewerID,
    messages,
  };
}

/**
 * Parse inbox response bodies into threads. Same thread arriving in several
 * bodies is merged: messages dedupe by id, the newest activity wins, and empty
 * identity fields are filled from whichever body carried them.
 */
export function parseInboxBodies(bodies) {
  const byID = new Map();
  for (const body of bodies ?? []) {
    for (const root of jsonObjects(body)) {
      const dicts = [];
      collectThreads(root, dicts);
      for (const d of dicts) {
        const t = parseThread(d);
        if (!t) continue;
        const existing = byID.get(t.threadID);
        if (!existing) { byID.set(t.threadID, t); continue; }
        const seen = new Set(existing.messages.map((m) => m.id));
        for (const m of t.messages) if (!seen.has(m.id)) { existing.messages.push(m); seen.add(m.id); }
        existing.lastActivityMs = Math.max(existing.lastActivityMs, t.lastActivityMs);
        if (!existing.username) { existing.username = t.username; existing.displayName = t.displayName; }
        if (!existing.avatarURL) existing.avatarURL = t.avatarURL;
        if (!existing.viewerID) existing.viewerID = t.viewerID;
        if (!existing.igUserID) existing.igUserID = t.igUserID;
      }
    }
  }
  return [...byID.values()];
}

// Instagram states "there is another page" in more than one dialect: the Relay
// one (`page_info.end_cursor` / `has_next_page`) and the older private-API one
// (`oldest_cursor` / `has_older`), and the mailbox payload has been seen putting
// the thread list one level below the object that holds the cursor. So the
// cursor is looked for BY MEANING rather than at a fixed path.
const CURSOR_KEYS = ['end_cursor', 'oldest_cursor', 'next_cursor', 'next_max_id'];
const MORE_KEYS = ['has_next_page', 'has_older', 'has_more'];

const nodeOf = (edge) => (isObject(edge) && isObject(edge.node) ? edge.node : edge);
const isThreadDict = (d) =>
  isObject(d) && (d.as_ig_direct_thread !== undefined || d.thread_id !== undefined || d.thread_key !== undefined);

/** Does this object hold a list of THREADS (as opposed to messages, or users)? */
function carriesThreads(o) {
  if (Array.isArray(o.edges) && o.edges.length) return isThreadDict(nodeOf(o.edges[0]));
  for (const key of ['threads', 'threads_by_folder', 'items']) {
    if (Array.isArray(o[key]) && o[key].some(isThreadDict)) return true;
  }
  return false;
}

/** The paging on one object, in whichever dialect it is written. */
function cursorOn(holder) {
  if (!isObject(holder)) return null;
  const info = isObject(holder.page_info) ? holder.page_info : holder;
  let end = null;
  for (const key of CURSOR_KEYS) {
    if (typeof info[key] === 'string' && info[key]) { end = info[key]; break; }
  }
  const hasNext = MORE_KEYS.some((key) => info[key] === true);
  return end || hasNext ? { end, hasNext } : null;
}

/**
 * The thread-list pagination cursor: the paging that belongs to a list of
 * THREADS, not to the messages inside one. Prefers a list that reports another
 * page — a payload carries several, and the one that says "no more" is usually
 * a folder nobody asked about.
 */
export function threadListCursor(bodies) {
  let best = null;
  const consider = (found) => {
    if (!found) return;
    if (found.hasNext) best = found;
    else if (!best) best = found;
  };
  const walk = (node, parent) => {
    if (Array.isArray(node)) {
      for (const v of node) walk(v, parent);
      return;
    }
    if (!isObject(node)) return;
    // The list itself first; the object holding it only if the list says nothing.
    if (carriesThreads(node)) consider(cursorOn(node) ?? cursorOn(parent));
    for (const v of Object.values(node)) walk(v, node);
  };
  for (const body of bodies ?? []) for (const root of jsonObjects(body)) walk(root, null);
  return best;
}

/**
 * Where a payload keeps its paging — for when the reader above found nothing and
 * the only honest next step is to look at the real answer.
 *
 * Paths and types, never values: a body is full of what people wrote to each
 * other, and this is written into `health`, which leaves the browser over the
 * bridge. Booleans are the exception — `has_next_page: false` IS the finding.
 */
export function pagingProbe(body, limit = 40) {
  const interesting = /cursor|page_info|has_next|has_older|has_more|next_max_id/i;
  const found = [];
  const walk = (node, path) => {
    if (found.length >= limit || !isObject(node)) return;
    for (const [key, value] of Object.entries(node)) {
      const here = path ? `${path}.${key}` : key;
      if (Array.isArray(value)) {
        // Where the threads live is half the answer: a cursor means nothing
        // until you know which list it pages.
        if (/thread|item/i.test(key)) found.push(`${here}[${value.length}]`);
        for (const v of value.slice(0, 2)) walk(v, `${here}[]`);
      } else if (isObject(value)) {
        if (interesting.test(key)) found.push(`${here}{${Object.keys(value).join(',')}}`);
        walk(value, here);
      } else if (interesting.test(key)) {
        found.push(`${here}=${typeof value === 'boolean' ? value : typeof value}`);
      }
    }
  };
  for (const root of jsonObjects(body)) walk(root, '');
  return [...new Set(found)].slice(0, limit);
}

/**
 * Swap `variables.cursor` inside a form-encoded request body, leaving every
 * other field (session tokens, doc_id, friendly_name) byte for byte intact.
 * Returns null when there is no parseable `variables=` field — the caller then
 * simply doesn't paginate.
 */
export function swapInboxCursor(postData, cursor) {
  const parts = String(postData ?? '').split('&');
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].startsWith('variables=')) continue;
    const raw = parts[i].slice('variables='.length);
    let obj;
    try { obj = JSON.parse(decodeURIComponent(raw)); } catch { return null; }
    // Not `!isObject(obj)` alone: a query with no cursor variable ignores the one
    // we add and answers with its own first page forever.
    if (!isObject(obj) || !('cursor' in obj)) return null;
    obj.cursor = cursor;
    parts[i] = 'variables=' + encodeURIComponent(JSON.stringify(obj));
    return parts.join('&');
  }
  return null;
}

/**
 * Point a captured conversation QUERY at another conversation. Variable names
 * read off this account's real traffic: `thread_fbid` says which conversation,
 * `min_uq_seq_id` how far back — null for the newest page, since the sequence
 * number of one conversation means nothing in another.
 *
 * Returns null when the body has no `thread_fbid` to replace: a request that
 * does not name a conversation is not the conversation query, and sending it
 * anyway would fetch something nobody asked for.
 */
export function swapThreadVariables(postData, threadFbid, minSeq = null) {
  const parts = String(postData ?? '').split('&');
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].startsWith('variables=')) continue;
    let obj;
    try { obj = JSON.parse(decodeURIComponent(parts[i].slice('variables='.length))); } catch { return null; }
    if (!isObject(obj) || !('thread_fbid' in obj)) return null;
    obj.thread_fbid = String(threadFbid);
    if ('min_uq_seq_id' in obj) obj.min_uq_seq_id = minSeq;
    parts[i] = 'variables=' + encodeURIComponent(JSON.stringify(obj));
    return parts.join('&');
  }
  return null;
}

/**
 * The NAMES of the variables a captured request sends — never their values,
 * which carry session tokens. What a caller needs to know before it can ask the
 * same query about another conversation, or about an older page of one.
 */
export function variableKeys(postData) {
  return Object.keys(requestVariables(postData) ?? {});
}

/** The variables a captured request sends, parsed. null when there are none. */
export function requestVariables(postData) {
  for (const part of String(postData ?? '').split('&')) {
    if (!part.startsWith('variables=')) continue;
    try {
      const obj = JSON.parse(decodeURIComponent(part.slice('variables='.length)));
      return isObject(obj) ? obj : null;
    } catch { return null; }
  }
  return null;
}

/**
 * Can this request be asked for the NEXT page? Only if the query already takes a
 * cursor. Splicing one into a query that has no such variable produces a request
 * that looks fine and is answered with the same page every time — a walk that
 * never moves and never fails.
 */
export const canPaginate = (postData) => {
  const vars = requestVariables(postData);
  return Boolean(vars) && 'cursor' in vars;
};

/**
 * Classify a response as a soft block. Body markers count ONLY at a top-level
 * error shape: the inbox payload embeds text other people wrote, so an
 * unanchored scan would let any lead park the account by messaging the word.
 * Returns 'rateLimited' | 'challenge' | null.
 */
export function classifyInboxBlock(status, url, body) {
  if (status === 429) return 'rateLimited';
  const u = String(url ?? '').toLowerCase();
  if (u.includes('/challenge') || u.includes('/accounts/login') || u.includes('/accounts/suspended')) return 'challenge';
  if (status === 401 || status === 403) return 'challenge';
  let root;
  try { root = JSON.parse(body); } catch { return null; }
  if (!isObject(root)) return null;
  for (const key of ['message', 'error_type', 'status']) {
    if (root[key] === 'checkpoint_required' || root[key] === 'challenge_required') return 'challenge';
  }
  return null;
}

function threadItemText(it) {
  if (typeof it.text === 'string' && it.text) return it.text;
  switch (it.item_type) {
    case 'media': case 'raven_media': case 'media_share': case 'clip': case 'felix_share': return '[media]';
    case 'voice_media': return '[voice]';
    case 'story_share': case 'reel_share': return '[story]';
    case 'like': return '❤';
    case 'animated_media': return '[gif]';
    case 'link': return (isObject(it.link) && typeof it.link.text === 'string' ? it.link.text : '') || '[link]';
    case 'placeholder': return isObject(it.placeholder) && typeof it.placeholder.message === 'string' ? it.placeholder.message : '';
    case 'action_log': case undefined: case '': return '';
    default: return `[${it.item_type}]`;
  }
}

/** The thread id out of a `/api/v1/direct_v2/threads/<id>/…` URL. '' when absent. */
export function threadIDFromURL(url) {
  const m = /\/api\/v1\/direct_v2\/threads\/([^/?#]+)/.exec(String(url ?? ''));
  return m ? decodeURIComponent(m[1]) : '';
}

/**
 * Point a captured thread request at another conversation, and optionally at an
 * older page of it. Every other query param Instagram put there is left alone —
 * they carry the limits and flags its own client asks for.
 *
 * Returns null when the url is not a thread request, so a caller with a stale
 * template does not silently fetch something else.
 */
export function swapThreadURL(url, threadID, cursor = null) {
  const raw = String(url ?? '');
  if (!threadIDFromURL(raw)) return null;
  const swapped = raw.replace(
    /(\/api\/v1\/direct_v2\/threads\/)([^/?#]+)/,
    (_, head) => head + encodeURIComponent(threadID),
  );
  let out;
  try { out = new URL(swapped); } catch { return null; }
  if (cursor) out.searchParams.set('cursor', cursor);
  else out.searchParams.delete('cursor');
  return out.toString();
}

/** One page of a thread's history from `/api/v1/direct_v2/threads/<id>/`. */
export function parseThreadPage(body) {
  let root;
  try { root = JSON.parse(body); } catch { return null; }
  if (!isObject(root)) return null;
  const thread = isObject(root.thread) ? root.thread : root;
  const viewerID = pkStr(thread.viewer_id);

  const messages = [];
  for (const it of Array.isArray(thread.items) ? thread.items : []) {
    if (!isObject(it)) continue;
    const id = pkStr(it.item_id);
    if (!id) continue;
    messages.push({
      id,
      senderFbid: pkStr(it.user_id),
      timestampMs: ms(it.timestamp) / 1000, // IG sends microseconds here
      text: threadItemText(it),
    });
  }

  // last_seen_at is keyed by user pk; the entry that isn't the viewer is the lead's.
  let leadLastSeenMs = 0;
  if (isObject(thread.last_seen_at)) {
    for (const [pk, v] of Object.entries(thread.last_seen_at)) {
      if (pk === viewerID || !isObject(v)) continue;
      const t = ms(v.timestamp) / 1000;
      if (t > leadLastSeenMs) leadLastSeenMs = t;
    }
  }

  // The inbox payload names everyone EXCEPT the logged-in account, so the CRM
  // knows itself by number only. `inviter` is a name, and it is ours precisely
  // when the inviter is the viewer — i.e. this is a thread we started.
  const inviter = isObject(thread.inviter) ? thread.inviter : null;
  const viewerUsername =
    inviter && viewerID && pkStr(inviter.pk) === viewerID && typeof inviter.username === 'string'
      ? inviter.username
      : '';

  // The other place Instagram describes the person, and the one that arrives
  // when the linked tab opens a conversation. The inbox payload does not always
  // carry a profile picture; this one does, and a picture is the only field on a
  // row that goes stale on its own — its url is signed and expires.
  let lead = null;
  for (const u of Array.isArray(thread.users) ? thread.users : []) {
    if (!isObject(u)) continue;
    const igUserID = pkStr(u.pk ?? u.id);
    if (!igUserID || igUserID === viewerID) continue;
    lead = {
      igUserID,
      username: typeof u.username === 'string' ? u.username : '',
      displayName: typeof u.full_name === 'string' ? u.full_name : '',
      avatarURL: typeof u.profile_pic_url === 'string' ? u.profile_pic_url : '',
    };
    break;
  }

  return {
    viewerID,
    viewerUsername,
    lead,
    oldestCursor: typeof thread.oldest_cursor === 'string' ? thread.oldest_cursor : null,
    hasOlder: thread.has_older === true,
    messages,
    leadLastSeenMs,
  };
}

/** The paging of a MESSAGE list — the mirror of threadListCursor, for one conversation. */
export function messageListCursor(bodies) {
  let best = null;
  const walk = (node) => {
    if (Array.isArray(node)) { for (const v of node) walk(v); return; }
    if (!isObject(node)) return;
    if (Array.isArray(node.edges) && node.edges.length && !isThreadDict(nodeOf(node.edges[0]))) {
      const found = cursorOn(node);
      if (found && (found.hasNext || !best)) best = found;
    }
    for (const v of Object.values(node)) walk(v);
  };
  for (const body of bodies ?? []) for (const root of jsonObjects(body)) walk(root);
  return best;
}

/**
 * One conversation, in whichever dialect it arrived: the old REST endpoint, or
 * the GraphQL query that answers in the mailbox's own shape with a single thread
 * in it. Same result either way, so the caller does not have to know which.
 */
export function parseConversation(body) {
  const rest = parseThreadPage(body);
  if (rest?.messages.length) return rest;

  const [thread] = parseInboxBodies([body]);
  if (!thread) return rest;
  const paging = messageListCursor([body]);
  return {
    viewerID: thread.viewerID,
    viewerUsername: '',
    lead: thread.igUserID
      ? { igUserID: thread.igUserID, username: thread.username, displayName: thread.displayName, avatarURL: thread.avatarURL }
      : null,
    oldestCursor: paging?.end ?? null,
    hasOlder: paging?.hasNext === true,
    messages: thread.messages,
    leadLastSeenMs: 0,
  };
}

/**
 * A lead "replied" when an inbound message follows one of ours. Someone who
 * wrote first has not replied to outreach — that distinction is what makes the
 * reply rate mean anything.
 */
export function computeReplied(messages) {
  const sorted = [...(messages ?? [])].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  let sawOutbound = false;
  for (const m of sorted) {
    if (m.direction === 'out') sawOutbound = true;
    else if (m.direction === 'in' && sawOutbound) return true;
  }
  return false;
}
