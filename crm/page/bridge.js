// The CRM's end of the local bridge. Chrome will not let anything outside the
// browser read an extension's storage, so the page does both halves itself:
// it pushes a snapshot out, and polls for commands coming back.
//
//   storage changed ──▶ push /sync              (debounced: ingest fires in bursts)
//   every few sec   ──▶ poll /pending?source=…  ──▶ apply ──▶ /ack
//
// The daemon serves every browser and every Chrome profile at once, and each of
// those has its own storage and its own Instagram account. So this instance
// stamps everything with a source id of its own — generated once, kept in
// storage — and only ever asks for commands addressed to it.
//
// Everything here fails quietly. The bridge is optional: with the daemon down
// the CRM must work exactly as it did before, so a dead socket only slows the
// polling down — the status it reports goes dark rather than red.
//
// What it does report, because it would otherwise be invisible forever: a
// command that arrived, failed to apply and is still queued.

import { buildSnapshot, isSnapshotKey } from '../lib/snapshot.js';

const BASE = 'http://127.0.0.1:8788';
const SOURCE_KEY = 'bridgeSource';
const PUSH_DEBOUNCE_MS = 1500;
const POLL_MS = 5000;
const POLL_MS_WHEN_DOWN = 30000;
/**
 * A request that never answers must not be able to wedge the pusher.
 *
 * `push` lets one run at a time, and the flag that enforces that is released
 * when the request settles — so a fetch that neither resolves nor rejects holds
 * it forever. Measured: after four thousand conversations the CRM stopped
 * pushing entirely and stayed that way for half an hour, while acks — which
 * nothing gates — kept going, so the bridge looked connected and served a
 * snapshot that was twenty minutes old. Long enough for megabytes on a busy
 * machine, short enough that being stuck is a retry rather than the end.
 */
const POST_TIMEOUT_MS = 30000;

let pushTimer = null;
let pollTimer = null;
let pollDelay = POLL_MS;
let pushing = false;
let pushAgain = false;
/** Last known state of the bridge, as the topbar chip shows it. */
const status = { live: false, syncedAt: null, stuck: 0, unsent: 0 };

/**
 * `fetch` resolves on 4xx and 5xx, so a bare await would call a refused push a
 * success — and, worse, an ack that never landed. Unacked commands come back on
 * the next poll and are applied a second time.
 */
async function post(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${path} → ${response.status}`);
  return response;
}

/**
 * This CRM's identity on the bridge. Not `chrome.runtime.id` — an unpacked
 * extension gets the same id in every profile that loads the folder, so two
 * profiles would claim to be one another.
 */
async function sourceId() {
  const got = await chrome.storage.local.get(SOURCE_KEY);
  if (typeof got[SOURCE_KEY] === 'string' && got[SOURCE_KEY]) return got[SOURCE_KEY];
  const fresh = `s-${crypto.randomUUID()}`;
  await chrome.storage.local.set({ [SOURCE_KEY]: fresh });
  return fresh;
}

/**
 * A full inbox with history is megabytes, so a push can outlast the debounce.
 * Two in flight land in whatever order the socket decides and the daemon stamps
 * the LAST one as the newest — an older snapshot overwriting a newer one and
 * looking fresher. So: one at a time, with a repeat if anything changed while
 * this one was in the air.
 */
async function push() {
  if (pushing) { pushAgain = true; return; }
  pushing = true;
  try {
    const [dump, source] = await Promise.all([chrome.storage.local.get(null), sourceId()]);
    await post('/sync', { sourceId: source, ...buildSnapshot(dump) });
    status.syncedAt = Date.now();
    status.unsent = 0;
  } catch (e) {
    // A snapshot that is not landing has to say so. Polling still answers, so
    // the bridge goes on looking connected while it serves a copy of the inbox
    // that stopped moving — and reading a stale one as current is the failure
    // nothing downstream can catch. The poll loop carries this to the chip on
    // its next tick; it runs every few seconds and owns that reporting.
    status.unsent += 1;
    throw e;
  } finally {
    pushing = false;
    if (pushAgain) { pushAgain = false; push().catch(() => {}); }
  }
}

/**
 * `patch` goes through the service worker so it lands in the store's single
 * write queue — writing to storage straight from here would race the capture
 * that is running in the background. `draft` only fills the composer: the
 * bridge never sends a message to a lead on its own.
 *
 * Throwing leaves the command queued for the next tick — which is why onDraft is
 * awaited: it refuses when the composer already holds something a person typed.
 */
async function apply(command, { onDraft }) {
  if (command.type === 'backfill') {
    // Minutes, not milliseconds. Awaited on purpose: the ack has to mean the
    // walk finished, or a poll five seconds later would start a second one on
    // top of the first. The poll loop waits for this and that is fine — the
    // whole point of the command is that this walk is the work.
    const result = await chrome.runtime.sendMessage({ type: 'crm-backfill' });
    // No answer at all is a sleeping worker, and that is worth another tick. Any
    // answer — including a walk that stopped early — means the walk happened;
    // re-running it every five seconds would open tabs and hammer Instagram.
    // Why it stopped is in `health`, which the next snapshot carries out.
    if (!result) throw new Error('no answer');
    return;
  }
  if (command.type === 'patch') {
    const result = await chrome.runtime.sendMessage({
      type: 'crm-patch',
      threadID: command.threadID,
      fields: command.fields,
    });
    // The thread is addressed to this account but hasn't been captured yet —
    // retry rather than swallow it. A patch that changed nothing is still done.
    if (!result?.found) throw new Error('thread not captured yet');
    return;
  }
  if (command.type === 'draft') await onDraft?.(command.threadID, command.text);
}

async function poll(handlers) {
  const source = await sourceId();
  const response = await fetch(`${BASE}/pending?source=${encodeURIComponent(source)}`);
  const { commands } = await response.json();
  if (!commands?.length) {
    status.stuck = 0;
    return;
  }

  const done = [];
  for (const command of commands) {
    try {
      await apply(command, handlers);
      done.push(command.id);
    } catch {
      // Left queued on purpose: the worker may be asleep, or the thread may
      // arrive with the next capture. Counted, so it isn't invisible.
    }
  }
  status.stuck = commands.length - done.length;
  if (done.length) await post('/ack', { ids: done });
}

export function startBridge(handlers = {}) {
  const schedule = () => {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(tick, pollDelay);
  };
  const tick = async () => {
    try {
      await poll(handlers);
      status.live = true;
      pollDelay = POLL_MS;
    } catch {
      // The daemon isn't running. Stop hammering it, and say nothing: a bridge
      // nobody started is not a fault to report.
      status.live = false;
      status.stuck = 0;
      pollDelay = POLL_MS_WHEN_DOWN;
    }
    handlers.onStatus?.({ ...status });
    schedule();
  };

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    // Only what the snapshot is made of: this storage is shared with the send
    // run, whose own keys change several times a second.
    if (!Object.keys(changes).some(isSnapshotKey)) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => push().catch(() => {}), PUSH_DEBOUNCE_MS);
  });

  push().catch(() => {});
  tick();
}
