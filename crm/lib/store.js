// Storage over chrome.storage.local. Ported from siluet's InboxStore merge rules
// (App.swift:3768) — dedupe by message id, newest activity wins, `replied` and
// `needsAttention` derived the same way.
//
// Two things this file exists to guarantee:
//   1. Every read-modify-write runs through ONE promise queue. The service
//      worker dies between events and a passive capture can overlap a manual
//      refresh; unserialized merges lose whichever landed first.
//   2. Nothing is written when nothing changed. Instagram refetches the same
//      inbox constantly.
//
//   ingest(threads) ──▶ queue ──▶ read index ──▶ merge ──▶ dirty? ──▶ write
//                                                             └─ no ──▶ skip

import { computeReplied } from './parser.js';
import { AVATARS_KEY } from './avatars.js';

const INDEX_KEY = 'threads';
const TEMPLATE_KEY = 'tpl';
const PAGE_TEMPLATE_KEY = 'tplPage';
const THREAD_TEMPLATE_KEY = 'tplThread';
const VIEWER_KEY = 'viewer';
const HEALTH_KEY = 'health';

/** Threads are scoped per logged-in account so switching never mixes inboxes. */
const rowKey = (viewerFbid, threadID) => `${viewerFbid}|${threadID}`;
const msgKey = (viewerFbid, threadID) => `msg:${rowKey(viewerFbid, threadID)}`;

function toMessage(parsed, viewerFbid) {
  return {
    id: parsed.id,
    direction: parsed.senderFbid && parsed.senderFbid === viewerFbid ? 'out' : 'in',
    text: parsed.text,
    timestamp: parsed.timestampMs,
  };
}

const byTime = (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0);

export function createStore(area) {
  let queue = Promise.resolve();

  /** Serialize every mutation; failures don't poison the chain. */
  function serial(work) {
    const run = queue.then(work, work);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async function readIndex() {
    const got = await area.get(INDEX_KEY);
    return Array.isArray(got[INDEX_KEY]) ? got[INDEX_KEY] : [];
  }

  async function ingest(parsedThreads, viewerFbid) {
    return serial(async () => {
      const index = await readIndex();
      const position = new Map(index.map((t, i) => [rowKey(t.viewerFbid, t.threadID), i]));
      const writes = {};
      let added = 0;
      let updated = 0;
      let newInbound = 0;

      for (const parsed of parsedThreads) {
        if (!parsed?.threadID) continue;
        const key = rowKey(viewerFbid, parsed.threadID);
        const at = position.get(key);
        const existing = at === undefined ? null : index[at];

        const stored = existing ? (await area.get(msgKey(viewerFbid, parsed.threadID)))[msgKey(viewerFbid, parsed.threadID)] ?? [] : [];
        const seen = new Set(stored.map((m) => m.id));
        const merged = [...stored];
        let freshInbound = 0;
        for (const p of parsed.messages ?? []) {
          if (!p.id || seen.has(p.id)) continue;
          const m = toMessage(p, viewerFbid);
          merged.push(m);
          seen.add(m.id);
          if (m.direction === 'in') freshInbound++;
        }
        merged.sort(byTime);

        const messagesChanged = merged.length !== stored.length;
        const last = merged[merged.length - 1];
        // Whether the last word is ours. A reply sent from the phone arrives
        // here as an ordinary captured message: nobody pressed anything in the
        // CRM, but the conversation has been dealt with — and a flag only a
        // click can clear would keep saying otherwise every morning.
        const answered = last ? last.direction === 'out' : Boolean(existing?.lastOutbound);
        // Spread the existing row FIRST: slice 2 writes stage/tags/note onto it,
        // and ingest runs in the background — dropping unknown keys would erase
        // the operator's own CRM work on the next refresh.
        const row = {
          ...(existing ?? {}),
          threadID: parsed.threadID,
          viewerFbid,
          username: parsed.username || existing?.username || '',
          displayName: parsed.displayName || existing?.displayName || '',
          avatarURL: parsed.avatarURL || existing?.avatarURL || '',
          igUserID: parsed.igUserID || existing?.igUserID || '',
          lastActivityAt: Math.max(parsed.lastActivityMs ?? 0, existing?.lastActivityAt ?? 0),
          lastMessage: last?.text ?? existing?.lastMessage ?? '',
          lastOutbound: answered,
          messageCount: merged.length,
          replied: computeReplied(merged),
          // Any inbound the CRM has not stored before is unacknowledged — including
          // on the very first sighting, otherwise installing the extension would
          // silently mark every already-waiting reply as read. Never derived from
          // Instagram's own unread indicator: it is cleared by markRead, or by an
          // answer of ours turning up from anywhere.
          needsAttention: !answered && ((existing?.needsAttention ?? false) || freshInbound > 0),
        };

        const rowChanged = !existing || JSON.stringify(existing) !== JSON.stringify(row);
        if (!rowChanged && !messagesChanged) continue;

        if (messagesChanged) writes[msgKey(viewerFbid, parsed.threadID)] = merged;
        if (existing) { index[at] = row; updated++; } else { position.set(key, index.length); index.push(row); added++; }
        newInbound += freshInbound;
      }

      if (added || updated) {
        index.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
        writes[INDEX_KEY] = index;
      }
      if (Object.keys(writes).length) await area.set(writes);
      return { added, updated, newInbound };
    });
  }

  /**
   * Merge messages that arrived outside the inbox list (a thread page opened in
   * the linked tab). Direction is resolved by the caller: the inbox payload and
   * the thread API identify the viewer by DIFFERENT ids, so deciding it here
   * would silently flip who said what.
   */
  async function ingestMessages(viewerFbid, threadID, incoming) {
    return serial(async () => {
      const key = msgKey(viewerFbid, threadID);
      const got = await area.get([INDEX_KEY, key]);
      const stored = Array.isArray(got[key]) ? got[key] : [];
      const seen = new Set(stored.map((m) => m.id));
      const merged = [...stored];
      let added = 0;
      for (const m of incoming ?? []) {
        if (!m?.id || seen.has(m.id)) continue;
        merged.push(m);
        seen.add(m.id);
        added++;
      }
      if (!added) return { added: 0 };
      merged.sort(byTime);

      const writes = { [key]: merged };
      const index = Array.isArray(got[INDEX_KEY]) ? got[INDEX_KEY] : [];
      const at = index.findIndex((t) => t.viewerFbid === viewerFbid && t.threadID === threadID);
      if (at !== -1) {
        const last = merged[merged.length - 1];
        const answered = last?.direction === 'out';
        index[at] = {
          ...index[at],
          messageCount: merged.length,
          lastMessage: last?.text ?? index[at].lastMessage,
          lastOutbound: answered,
          lastActivityAt: Math.max(index[at].lastActivityAt ?? 0, last?.timestamp ?? 0),
          replied: computeReplied(merged),
          // The full history can end in a reply sent from another device — same
          // rule as an inbox capture: our own last word settles the thread.
          needsAttention: answered ? false : index[at].needsAttention,
        };
        index.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
        writes[INDEX_KEY] = index;
      }
      await area.set(writes);
      return { added };
    });
  }

  async function listThreads(viewerFbid) {
    const index = await readIndex();
    const mine = viewerFbid ? index.filter((t) => t.viewerFbid === viewerFbid) : index;
    return [...mine].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  }

  async function messages(viewerFbid, threadID) {
    const key = msgKey(viewerFbid, threadID);
    const got = await area.get(key);
    return Array.isArray(got[key]) ? got[key] : [];
  }

  /**
   * The operator's own columns — the only keys anything may write onto a row.
   * Everything else on a row is what Instagram said, and a patch must not be
   * able to rewrite that: patches arrive from the bridge, i.e. from outside.
   *
   * `stageChangedAt` is deliberately NOT here. It is stamped below, by the move
   * itself: it exists to say "nothing has happened to this lead in three weeks",
   * and a field the caller can set is one that can lie about exactly that.
   */
  const CRM_FIELDS = ['stage', 'note', 'tags', 'followUpAt', 'folderID'];

  /**
   * The same patch onto many rows, in ONE read and ONE write. A bulk action that
   * looped over patchThread would fire a storage event per row, and every page
   * listening repaints on each of them — fifty picked rows, fifty repaints.
   *
   * Counts rather than booleans: "two of the five you named are in this inbox".
   */
  async function patchThreads(viewerFbid, threadIDs, fields) {
    return serial(async () => {
      const wanted = new Set(threadIDs ?? []);
      if (!wanted.size) return { found: 0, changed: 0 };
      const index = await readIndex();
      const movedAt = Date.now();
      let found = 0;
      let changed = 0;

      for (let at = 0; at < index.length; at++) {
        if (index[at].viewerFbid !== viewerFbid || !wanted.has(index[at].threadID)) continue;
        found++;

        const row = { ...index[at] };
        let dirty = false;
        let moved = false;
        for (const key of CRM_FIELDS) {
          if (!(key in (fields ?? {}))) continue;
          if (JSON.stringify(row[key]) === JSON.stringify(fields[key])) continue;
          row[key] = fields[key];
          dirty = true;
          if (key === 'stage') moved = true;
        }
        if (!dirty) continue;
        if (moved) row.stageChangedAt = movedAt;
        index[at] = row;
        changed++;
      }

      if (changed) await area.set({ [INDEX_KEY]: index });
      return { found, changed };
    });
  }

  // `found` and `changed` are separate on purpose: the bridge must retry a patch
  // for a thread this account hasn't captured yet, and must NOT retry one that
  // simply set the value it already had.
  async function patchThread(viewerFbid, threadID, fields) {
    const { found, changed } = await patchThreads(viewerFbid, [threadID], fields);
    return { found: found > 0, changed: changed > 0 };
  }

  /**
   * What Instagram said about the person, from a thread page rather than the
   * inbox list. A separate door from `patchThread` on purpose: that one guards
   * the operator's columns against the bridge, and this one is the opposite
   * direction — it may write identity and must never touch stage, note or tags.
   *
   * Only non-empty values land. A thin thread page answering with '' means "no
   * answer", not "this person has no name", and writing it would erase a row
   * the inbox had already filled in.
   */
  const IDENTITY_FIELDS = ['username', 'displayName', 'avatarURL', 'igUserID'];

  async function noteIdentity(viewerFbid, threadID, lead) {
    return serial(async () => {
      const index = await readIndex();
      const at = index.findIndex((t) => t.viewerFbid === viewerFbid && t.threadID === threadID);
      if (at === -1) return { found: false, changed: false };

      const row = { ...index[at] };
      let changed = false;
      for (const key of IDENTITY_FIELDS) {
        const value = lead?.[key];
        if (typeof value !== 'string' || !value || row[key] === value) continue;
        row[key] = value;
        changed = true;
      }
      if (!changed) return { found: true, changed: false };

      index[at] = row;
      await area.set({ [INDEX_KEY]: index });
      return { found: true, changed: true };
    });
  }

  /** How many dots were actually cleared — the rest were already read. */
  /**
   * How far the history backfill got in this conversation. Two facts, both of
   * which the next pass needs from the row alone: when it was read, and whether
   * Instagram still had older messages when it stopped. Without the second one
   * a run that hit the page cap looks exactly like a finished one.
   */
  async function noteHistory(viewerFbid, threadID, { at, hasOlder }) {
    return serial(async () => {
      const index = await readIndex();
      const position = index.findIndex((t) => t.viewerFbid === viewerFbid && t.threadID === threadID);
      if (position === -1) return { found: false };
      index[position] = { ...index[position], historyAt: at, historyOlder: hasOlder === true };
      await area.set({ [INDEX_KEY]: index });
      return { found: true };
    });
  }

  async function markReadMany(viewerFbid, threadIDs) {
    return serial(async () => {
      const wanted = new Set(threadIDs ?? []);
      if (!wanted.size) return 0;
      const index = await readIndex();
      let cleared = 0;
      for (let at = 0; at < index.length; at++) {
        const row = index[at];
        if (row.viewerFbid !== viewerFbid || !wanted.has(row.threadID) || !row.needsAttention) continue;
        index[at] = { ...row, needsAttention: false };
        cleared++;
      }
      if (cleared) await area.set({ [INDEX_KEY]: index });
      return cleared;
    });
  }

  const markRead = async (viewerFbid, threadID) => (await markReadMany(viewerFbid, [threadID])) > 0;

  async function readKey(key) {
    const got = await area.get(key);
    return got[key] ?? null;
  }

  return {
    ingest,
    ingestMessages,
    listThreads,
    messages,
    markRead,
    markReadMany,
    patchThread,
    patchThreads,
    noteIdentity,
    noteHistory,
    getTemplate: () => readKey(TEMPLATE_KEY),
    setTemplate: (tpl) => area.set({ [TEMPLATE_KEY]: tpl }),
    getPageTemplate: () => readKey(PAGE_TEMPLATE_KEY),
    setPageTemplate: (tpl) => area.set({ [PAGE_TEMPLATE_KEY]: tpl }),
    getThreadTemplate: () => readKey(THREAD_TEMPLATE_KEY),
    setThreadTemplate: (tpl) => area.set({ [THREAD_TEMPLATE_KEY]: tpl }),
    // Kept profile pictures, keyed by IG user id — one object rather than a key
    // each, so a pass that fetches a dozen of them repaints the page once.
    getAvatars: async () => (await readKey(AVATARS_KEY)) ?? {},
    setAvatars: (kept) => area.set({ [AVATARS_KEY]: kept }),
    getViewer: () => readKey(VIEWER_KEY),
    setViewer: (v) => area.set({ [VIEWER_KEY]: v }),
    getHealth: async () => (await readKey(HEALTH_KEY)) ?? {},
    patchHealth: (patch) => serial(async () => {
      const current = (await readKey(HEALTH_KEY)) ?? {};
      await area.set({ [HEALTH_KEY]: { ...current, ...patch } });
    }),
  };
}
