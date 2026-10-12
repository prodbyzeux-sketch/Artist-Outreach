import test from 'node:test';
import assert from 'node:assert/strict';

import { createStore } from '../lib/store.js';

/** Stand-in for chrome.storage.local: same get/set contract, in memory. */
function fakeArea(seed = {}) {
  const data = { ...seed };
  return {
    data,
    writes: 0,
    async get(keys) {
      const list = keys === null || keys === undefined ? Object.keys(data) : [].concat(keys);
      const out = {};
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(items) {
      this.writes++;
      for (const [k, v] of Object.entries(items)) data[k] = structuredClone(v);
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete data[k];
    },
  };
}

const VIEWER = '900';

function parsed(over = {}) {
  return {
    threadID: 't1',
    lastActivityMs: 2000,
    username: 'lead_one',
    displayName: 'Lead One',
    avatarURL: 'https://cdn/a.jpg',
    igUserID: '222',
    viewerID: VIEWER,
    messages: [
      { id: 'm1', senderFbid: VIEWER, timestampMs: 1000, text: 'hey' },
      { id: 'm2', senderFbid: '223', timestampMs: 2000, text: 'hi back' },
    ],
    ...over,
  };
}

test('ingest stores a thread with its messages and reports what is new', async () => {
  const area = fakeArea();
  const store = createStore(area);
  const result = await store.ingest([parsed()], VIEWER);

  assert.equal(result.added, 1);
  assert.equal(result.updated, 0);
  const threads = await store.listThreads(VIEWER);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].username, 'lead_one');
  assert.equal(threads[0].lastActivityAt, 2000);
  assert.equal(threads[0].messageCount, 2);
  assert.equal(threads[0].lastMessage, 'hi back');

  const msgs = await store.messages(VIEWER, 't1');
  assert.deepEqual(msgs.map((m) => m.id), ['m1', 'm2']);
  assert.deepEqual(msgs.map((m) => m.direction), ['out', 'in']);
});

test('re-ingesting the same payload changes nothing and writes nothing', async () => {
  const area = fakeArea();
  const store = createStore(area);
  await store.ingest([parsed()], VIEWER);
  const writesAfterFirst = area.writes;

  const second = await store.ingest([parsed()], VIEWER);
  assert.equal(second.added, 0);
  assert.equal(second.updated, 0);
  assert.equal(area.writes, writesAfterFirst, 'an unchanged inbox must not rewrite storage');
});

test('new messages merge in, dedupe by id and keep the newest activity', async () => {
  const area = fakeArea();
  const store = createStore(area);
  await store.ingest([parsed()], VIEWER);
  await store.ingest([parsed({
    lastActivityMs: 5000,
    messages: [
      { id: 'm2', senderFbid: '223', timestampMs: 2000, text: 'hi back' },
      { id: 'm3', senderFbid: '223', timestampMs: 5000, text: 'still there?' },
    ],
  })], VIEWER);

  const msgs = await store.messages(VIEWER, 't1');
  assert.deepEqual(msgs.map((m) => m.id), ['m1', 'm2', 'm3']);
  const [t] = await store.listThreads(VIEWER);
  assert.equal(t.lastActivityAt, 5000);
  assert.equal(t.lastMessage, 'still there?');
});

test('messages stay sorted by time even when IG returns them out of order', async () => {
  const area = fakeArea();
  const store = createStore(area);
  await store.ingest([parsed({
    messages: [
      { id: 'later', senderFbid: '223', timestampMs: 9000, text: 'second' },
      { id: 'earlier', senderFbid: '223', timestampMs: 1000, text: 'first' },
    ],
  })], VIEWER);
  const msgs = await store.messages(VIEWER, 't1');
  assert.deepEqual(msgs.map((m) => m.text), ['first', 'second']);
});

test('replied is true only when the lead answers our message', async () => {
  const area = fakeArea();
  const store = createStore(area);
  await store.ingest([parsed()], VIEWER);
  assert.equal((await store.listThreads(VIEWER))[0].replied, true);

  const cold = fakeArea();
  const coldStore = createStore(cold);
  await coldStore.ingest([parsed({
    threadID: 't2',
    messages: [{ id: 'a', senderFbid: '223', timestampMs: 1, text: 'you first' }],
  })], VIEWER);
  assert.equal((await coldStore.listThreads(VIEWER))[0].replied, false);
});

test('a new inbound message raises needsAttention; only an explicit read clears it', async () => {
  const area = fakeArea();
  const store = createStore(area);
  await store.ingest([parsed()], VIEWER);
  assert.equal((await store.listThreads(VIEWER))[0].needsAttention, true);

  await store.markRead(VIEWER, 't1');
  assert.equal((await store.listThreads(VIEWER))[0].needsAttention, false);

  // Re-ingesting the same messages must not re-raise the flag...
  await store.ingest([parsed()], VIEWER);
  assert.equal((await store.listThreads(VIEWER))[0].needsAttention, false);

  // ...but a genuinely new inbound message must.
  await store.ingest([parsed({
    lastActivityMs: 7000,
    messages: [{ id: 'm4', senderFbid: '223', timestampMs: 7000, text: 'ping' }],
  })], VIEWER);
  assert.equal((await store.listThreads(VIEWER))[0].needsAttention, true);
});

test('answering from the phone clears the dot without anybody opening the CRM', async () => {
  // The reply was sent from Instagram on a phone and arrives with the next
  // capture. Nobody pressed anything here, but the conversation is dealt with —
  // and a dot that only a click can clear says the opposite every morning.
  const area = fakeArea();
  const store = createStore(area);
  await store.ingest([parsed()], VIEWER);
  assert.equal((await store.listThreads(VIEWER))[0].needsAttention, true);

  await store.ingest([parsed({
    lastActivityMs: 6000,
    messages: [{ id: 'phone', senderFbid: VIEWER, timestampMs: 6000, text: 'sent from my phone' }],
  })], VIEWER);

  const [t] = await store.listThreads(VIEWER);
  assert.equal(t.needsAttention, false);
  assert.equal(t.lastOutbound, true, 'and the list can say the last word was ours');
});

test('they write again after our reply and the dot comes back', async () => {
  const area = fakeArea();
  const store = createStore(area);
  await store.ingest([parsed()], VIEWER);
  await store.ingest([parsed({
    lastActivityMs: 6000,
    messages: [{ id: 'phone', senderFbid: VIEWER, timestampMs: 6000, text: 'sent from my phone' }],
  })], VIEWER);

  await store.ingest([parsed({
    lastActivityMs: 7000,
    messages: [{ id: 'theirs', senderFbid: '223', timestampMs: 7000, text: 'how much' }],
  })], VIEWER);

  const [t] = await store.listThreads(VIEWER);
  assert.equal(t.needsAttention, true);
  assert.equal(t.lastOutbound, false);
});

test('a batch carrying their message and our answer together lands answered', async () => {
  const area = fakeArea();
  const store = createStore(area);
  await store.ingest([parsed({
    messages: [
      { id: 'theirs', senderFbid: '223', timestampMs: 1000, text: 'you there?' },
      { id: 'mine', senderFbid: VIEWER, timestampMs: 2000, text: 'yes' },
    ],
  })], VIEWER);
  const [t] = await store.listThreads(VIEWER);
  assert.equal(t.needsAttention, false, 'the newest word is ours, whatever came before it');
});

test('history arriving from the thread page settles the dot the same way', async () => {
  // The linked tab pulls the full history; the newest message in it may be a
  // reply sent from somewhere else entirely.
  const area = fakeArea();
  const store = createStore(area);
  await store.ingest([parsed()], VIEWER);

  await store.ingestMessages(VIEWER, 't1', [
    { id: 'elsewhere', direction: 'out', text: 'отправил с телефона', timestamp: 9000 },
  ]);
  const [t] = await store.listThreads(VIEWER);
  assert.equal(t.needsAttention, false);
  assert.equal(t.lastOutbound, true);
});

test('our own outbound message never raises needsAttention', async () => {
  const area = fakeArea();
  const store = createStore(area);
  await store.ingest([parsed({
    messages: [{ id: 'own', senderFbid: VIEWER, timestampMs: 1, text: 'opener' }],
  })], VIEWER);
  assert.equal((await store.listThreads(VIEWER))[0].needsAttention, false);
});

test('another account\'s threads are stored apart, not merged in', async () => {
  const area = fakeArea();
  const store = createStore(area);
  await store.ingest([parsed()], VIEWER);
  await store.ingest([parsed({ username: 'someone_else', viewerID: '777' })], '777');

  const mine = await store.listThreads(VIEWER);
  const theirs = await store.listThreads('777');
  assert.equal(mine.length, 1);
  assert.equal(theirs.length, 1);
  assert.equal(mine[0].username, 'lead_one');
  assert.equal(theirs[0].username, 'someone_else');
});

test('fields the merge does not know about survive it', async () => {
  // Slice 2 adds stage / tags / note straight onto the thread row. Ingest runs
  // constantly in the background; if it dropped unknown keys it would silently
  // erase the operator's CRM work on the next inbox refresh.
  const area = fakeArea();
  const store = createStore(area);
  await store.ingest([parsed()], VIEWER);

  const rows = area.data.threads;
  rows[0].stage = 'interested';
  rows[0].note = 'call back monday';
  await area.set({ threads: rows });

  await store.ingest([parsed({
    lastActivityMs: 8000,
    messages: [{ id: 'm5', senderFbid: '223', timestampMs: 8000, text: 'new' }],
  })], VIEWER);

  const [t] = await store.listThreads(VIEWER);
  assert.equal(t.stage, 'interested');
  assert.equal(t.note, 'call back monday');
  assert.equal(t.lastActivityAt, 8000);
});

test('concurrent ingests both land — no lost update', async () => {
  // The service worker is killed and restarted between events, and a passive
  // capture can overlap a manual refresh. Unserialized read-modify-write loses
  // whichever finished first.
  const area = fakeArea();
  const store = createStore(area);
  await Promise.all([
    store.ingest([parsed({ threadID: 'a', messages: [{ id: 'a1', senderFbid: '223', timestampMs: 1, text: 'a' }] })], VIEWER),
    store.ingest([parsed({ threadID: 'b', messages: [{ id: 'b1', senderFbid: '223', timestampMs: 1, text: 'b' }] })], VIEWER),
    store.ingest([parsed({ threadID: 'c', messages: [{ id: 'c1', senderFbid: '223', timestampMs: 1, text: 'c' }] })], VIEWER),
  ]);
  const ids = (await store.listThreads(VIEWER)).map((t) => t.threadID).sort();
  assert.deepEqual(ids, ['a', 'b', 'c']);
});

test('threads come back newest first', async () => {
  const area = fakeArea();
  const store = createStore(area);
  await store.ingest([
    parsed({ threadID: 'old', lastActivityMs: 100 }),
    parsed({ threadID: 'new', lastActivityMs: 900 }),
    parsed({ threadID: 'mid', lastActivityMs: 500 }),
  ], VIEWER);
  assert.deepEqual((await store.listThreads(VIEWER)).map((t) => t.threadID), ['new', 'mid', 'old']);
});

test('thread-page messages merge into the snippet ones without duplicating', async () => {
  // Opening the thread in the linked tab gives the full history; the inbox list
  // already gave the last one or two. The overlap must not double up.
  const area = fakeArea();
  const store = createStore(area);
  await store.ingest([parsed()], VIEWER);

  const result = await store.ingestMessages(VIEWER, 't1', [
    { id: 'older', direction: 'in', text: 'самое первое', timestamp: 10 },
    { id: 'm1', direction: 'out', text: 'hey', timestamp: 1000 },
    { id: 'm2', direction: 'in', text: 'hi back', timestamp: 2000 },
  ]);

  assert.equal(result.added, 1, 'only the message we had not seen');
  const msgs = await store.messages(VIEWER, 't1');
  assert.deepEqual(msgs.map((m) => m.id), ['older', 'm1', 'm2']);
  const [row] = await store.listThreads(VIEWER);
  assert.equal(row.messageCount, 3);
  assert.equal(row.lastMessage, 'hi back');
});

test('a reply we just sent lands in the thread and becomes its last message', async () => {
  const area = fakeArea();
  const store = createStore(area);
  await store.ingest([parsed()], VIEWER);

  await store.ingestMessages(VIEWER, 't1', [
    { id: 'mine', direction: 'out', text: 'вот прайс', timestamp: 9000 },
  ]);

  const [row] = await store.listThreads(VIEWER);
  assert.equal(row.lastMessage, 'вот прайс');
  assert.equal(row.lastActivityAt, 9000);
  assert.equal(row.replied, true, 'their earlier reply still counts');
});

test('ingesting messages for an unknown thread writes them without inventing a row', async () => {
  const area = fakeArea();
  const store = createStore(area);
  const result = await store.ingestMessages(VIEWER, 'ghost', [
    { id: 'g1', direction: 'in', text: 'привет', timestamp: 1 },
  ]);
  assert.equal(result.added, 1);
  assert.deepEqual((await store.messages(VIEWER, 'ghost')).map((m) => m.id), ['g1']);
  assert.deepEqual(await store.listThreads(VIEWER), []);
});

test('template, viewer and health round-trip', async () => {
  const area = fakeArea();
  const store = createStore(area);
  assert.equal(await store.getTemplate(), null);

  await store.setTemplate({ url: 'https://www.instagram.com/api/graphql', body: 'x=1', headers: { a: 'b' } });
  assert.equal((await store.getTemplate()).body, 'x=1');

  await store.setViewer({ fbid: VIEWER, username: 'me' });
  assert.equal((await store.getViewer()).fbid, VIEWER);

  await store.patchHealth({ lastError: 'boom' });
  await store.patchHealth({ lastSuccessAt: 42 });
  const health = await store.getHealth();
  assert.equal(health.lastError, 'boom', 'a patch must not wipe the rest of health');
  assert.equal(health.lastSuccessAt, 42);
});

test('patchThread writes CRM fields and leaves the captured ones alone', async () => {
  const area = fakeArea();
  const store = createStore(area);
  await store.ingest([parsed()], VIEWER);

  assert.deepEqual(await store.patchThread(VIEWER, 't1', { stage: 'demo-sent', note: 'просил видео' }), { found: true, changed: true });
  const [t] = await store.listThreads(VIEWER);
  assert.equal(t.stage, 'demo-sent');
  assert.equal(t.note, 'просил видео');
  assert.equal(t.username, 'lead_one', 'the captured row is untouched');
  assert.equal(t.messageCount, 2);
});

test('patchThread ignores fields outside the CRM whitelist', async () => {
  // The bridge is a local socket, but it is still input from outside the
  // extension: a command must not be able to rewrite what Instagram said.
  const area = fakeArea();
  const store = createStore(area);
  await store.ingest([parsed()], VIEWER);

  await store.patchThread(VIEWER, 't1', {
    stage: 'won', threadID: 'hacked', messageCount: 999, lastMessage: 'nope', viewerFbid: '000',
  });
  const [t] = await store.listThreads(VIEWER);
  assert.equal(t.stage, 'won');
  assert.equal(t.threadID, 't1');
  assert.equal(t.messageCount, 2);
  assert.equal(t.lastMessage, 'hi back');
  assert.equal(t.viewerFbid, VIEWER);
});

test('moving a lead to another stage records when', async () => {
  // Not patchable from outside: the age of a stage is the one number that says
  // "nothing has happened here", and a command that could set it could lie.
  const area = fakeArea();
  const store = createStore(area);
  await store.ingest([parsed()], VIEWER);
  const before = Date.now();

  await store.patchThread(VIEWER, 't1', { stage: 'pitched', stageChangedAt: 1 });
  const [t] = await store.listThreads(VIEWER);
  assert.ok(t.stageChangedAt >= before, 'stamped by the store, not by the caller');
});

test('a patch that leaves the stage alone leaves its age alone', async () => {
  const area = fakeArea();
  const store = createStore(area);
  await store.ingest([parsed()], VIEWER);
  await store.patchThread(VIEWER, 't1', { stage: 'pitched' });
  const [moved] = await store.listThreads(VIEWER);

  await store.patchThread(VIEWER, 't1', { note: 'called, no answer' });
  const [t] = await store.listThreads(VIEWER);
  assert.equal(t.stageChangedAt, moved.stageChangedAt, 'a note is not a move');

  await store.patchThread(VIEWER, 't1', { stage: 'pitched' });
  const [same] = await store.listThreads(VIEWER);
  assert.equal(same.stageChangedAt, moved.stageChangedAt, 'setting the stage it already had is not a move either');
});

test('a follow-up is set, moved and cleared', async () => {
  const area = fakeArea();
  const store = createStore(area);
  await store.ingest([parsed()], VIEWER);

  await store.patchThread(VIEWER, 't1', { followUpAt: 5000 });
  assert.equal((await store.listThreads(VIEWER))[0].followUpAt, 5000);

  assert.deepEqual(await store.patchThread(VIEWER, 't1', { followUpAt: null }), { found: true, changed: true });
  assert.equal((await store.listThreads(VIEWER))[0].followUpAt, null, 'cleared, not left behind');
});

test('patchThread separates "no such thread" from "nothing to change"', async () => {
  const area = fakeArea();
  const store = createStore(area);
  await store.ingest([parsed()], VIEWER);
  const writes = area.writes;

  // The bridge retries the first and drops the second, so they cannot share an answer.
  assert.deepEqual(await store.patchThread(VIEWER, 'nope', { stage: 'won' }), { found: false, changed: false });
  assert.equal(area.writes, writes);
});

test('patchThread that changes nothing writes nothing', async () => {
  const area = fakeArea();
  const store = createStore(area);
  await store.ingest([parsed()], VIEWER);
  await store.patchThread(VIEWER, 't1', { stage: 'demo-sent' });
  const writes = area.writes;

  assert.deepEqual(await store.patchThread(VIEWER, 't1', { stage: 'demo-sent' }), { found: true, changed: false });
  assert.equal(area.writes, writes, 'a no-op patch must not rewrite the index');
});

test('patchThread survives a later ingest', async () => {
  const area = fakeArea();
  const store = createStore(area);
  await store.ingest([parsed()], VIEWER);
  await store.patchThread(VIEWER, 't1', { stage: 'demo-sent', tags: ['producer'] });

  await store.ingest([parsed({
    lastActivityMs: 9000,
    messages: [{ id: 'm9', senderFbid: '223', timestampMs: 9000, text: 'so how much' }],
  })], VIEWER);

  const [t] = await store.listThreads(VIEWER);
  assert.equal(t.stage, 'demo-sent');
  assert.deepEqual(t.tags, ['producer']);
  assert.equal(t.lastMessage, 'so how much');
});

test('a folder is one of the operator own columns', async () => {
  const area = fakeArea();
  const store = createStore(area);
  await store.ingest([parsed()], VIEWER);

  await store.patchThread(VIEWER, 't1', { folderID: 'f1' });
  assert.equal((await store.listThreads(VIEWER))[0].folderID, 'f1');
  await store.patchThread(VIEWER, 't1', { folderID: null });
  assert.equal((await store.listThreads(VIEWER))[0].folderID, null, 'and taken back out again');
});

/** Several rows, one index, one write — what a bulk action needs. */
async function threeThreads() {
  const area = fakeArea();
  const store = createStore(area);
  await store.ingest([
    parsed({ threadID: 'a', lastActivityMs: 300 }),
    parsed({ threadID: 'b', lastActivityMs: 200 }),
    parsed({ threadID: 'c', lastActivityMs: 100 }),
  ], VIEWER);
  return { area, store };
}

test('patchThreads writes many rows in a single storage write', async () => {
  // One per row would be one storage event per row, and the page repaints on
  // every one of them: fifty selected rows would repaint the list fifty times.
  const { area, store } = await threeThreads();
  const writes = area.writes;

  const result = await store.patchThreads(VIEWER, ['a', 'c'], { folderID: 'f1' });
  assert.deepEqual(result, { found: 2, changed: 2 });
  assert.equal(area.writes, writes + 1);

  const rows = Object.fromEntries((await store.listThreads(VIEWER)).map((t) => [t.threadID, t]));
  assert.equal(rows.a.folderID, 'f1');
  assert.equal(rows.c.folderID, 'f1');
  assert.equal(rows.b.folderID, undefined, 'a row nobody picked is left alone');
});

test('patchThreads counts found and changed apart', async () => {
  const { store } = await threeThreads();
  await store.patchThreads(VIEWER, ['a'], { stage: 'offer' });

  const result = await store.patchThreads(VIEWER, ['a', 'b', 'ghost'], { stage: 'offer' });
  assert.deepEqual(result, { found: 2, changed: 1 }, 'a already had it; ghost is not in this inbox');
});

test('patchThreads writes nothing when it moved nothing', async () => {
  const { area, store } = await threeThreads();
  await store.patchThreads(VIEWER, ['a'], { stage: 'offer' });
  const writes = area.writes;

  assert.deepEqual(await store.patchThreads(VIEWER, ['a'], { stage: 'offer' }), { found: 1, changed: 0 });
  assert.deepEqual(await store.patchThreads(VIEWER, ['ghost'], { stage: 'won' }), { found: 0, changed: 0 });
  assert.equal(area.writes, writes);
});

test('patchThreads stamps the move on every row it moved', async () => {
  const { store } = await threeThreads();
  await store.patchThreads(VIEWER, ['a'], { stage: 'offer' });
  const stampedEarlier = (await store.listThreads(VIEWER)).find((t) => t.threadID === 'a').stageChangedAt;

  await store.patchThreads(VIEWER, ['a', 'b'], { stage: 'won' });
  const rows = Object.fromEntries((await store.listThreads(VIEWER)).map((t) => [t.threadID, t]));
  assert.ok(rows.b.stageChangedAt >= stampedEarlier);
  assert.ok(rows.a.stageChangedAt >= stampedEarlier, 'moved again, so stamped again');
  assert.equal(rows.c.stageChangedAt, undefined);
});

test('patchThreads stays inside the account that asked', async () => {
  const { store } = await threeThreads();
  await store.ingest([parsed({ threadID: 'a', username: 'someone_else', viewerID: '777' })], '777');

  await store.patchThreads(VIEWER, ['a'], { folderID: 'f1' });
  assert.equal((await store.listThreads('777'))[0].folderID, undefined, 'the same thread id in another inbox');
});

test('markRead clears several rows at once and still answers about one', async () => {
  const { area, store } = await threeThreads();
  const writes = area.writes;

  assert.equal(await store.markReadMany(VIEWER, ['a', 'b', 'ghost']), 2);
  assert.equal(area.writes, writes + 1, 'one write for the lot');
  const rows = Object.fromEntries((await store.listThreads(VIEWER)).map((t) => [t.threadID, t]));
  assert.equal(rows.a.needsAttention, false);
  assert.equal(rows.b.needsAttention, false);
  assert.equal(rows.c.needsAttention, true);

  assert.equal(await store.markRead(VIEWER, 'c'), true);
  assert.equal(await store.markRead(VIEWER, 'c'), false, 'already read: nothing to clear');
  assert.equal(await store.markRead(VIEWER, 'ghost'), false);
});

test('noteIdentity fills a row from what the thread page said', async () => {
  const area = fakeArea();
  const store = createStore(area);
  await store.ingest([parsed({ avatarURL: '', displayName: '' })], VIEWER);

  const result = await store.noteIdentity(VIEWER, 't1', {
    igUserID: '222', username: 'lead_one', displayName: 'Lead One', avatarURL: 'https://cdn/fresh.jpg',
  });
  assert.deepEqual(result, { found: true, changed: true });
  const [t] = await store.listThreads(VIEWER);
  assert.equal(t.avatarURL, 'https://cdn/fresh.jpg');
  assert.equal(t.displayName, 'Lead One');
});

test('noteIdentity never blanks what Instagram already told us', async () => {
  // The thread page can come back thin. An empty string there is "no answer",
  // not "this person has no name" — writing it would erase a good row.
  const area = fakeArea();
  const store = createStore(area);
  await store.ingest([parsed()], VIEWER);

  await store.noteIdentity(VIEWER, 't1', { igUserID: '', username: '', displayName: '', avatarURL: '' });
  const [t] = await store.listThreads(VIEWER);
  assert.equal(t.username, 'lead_one');
  assert.equal(t.avatarURL, 'https://cdn/a.jpg');
});

test('noteIdentity does not write when nothing moved', async () => {
  // The linked tab refetches a thread every time it is opened, and the identity
  // is the same every time. A write per open would repaint the whole page.
  const area = fakeArea();
  const store = createStore(area);
  await store.ingest([parsed()], VIEWER);
  const writes = area.writes;

  const result = await store.noteIdentity(VIEWER, 't1', {
    igUserID: '222', username: 'lead_one', displayName: 'Lead One', avatarURL: 'https://cdn/a.jpg',
  });
  assert.deepEqual(result, { found: true, changed: false });
  assert.equal(area.writes, writes);
});

test('noteIdentity cannot reach the operator own columns', async () => {
  // It carries what Instagram said, and it arrives from a page hook. Stage and
  // note are the operator's, and nothing coming off the wire may touch them.
  const area = fakeArea();
  const store = createStore(area);
  await store.ingest([parsed()], VIEWER);
  await store.patchThread(VIEWER, 't1', { stage: 'offer', note: 'wants the demo' });

  await store.noteIdentity(VIEWER, 't1', { username: 'lead_one', stage: 'new', note: '', tags: ['x'] });
  const [t] = await store.listThreads(VIEWER);
  assert.equal(t.stage, 'offer');
  assert.equal(t.note, 'wants the demo');
  assert.equal(t.tags, undefined);
});

test('noteHistory stamps when a conversation was read to the end, and how far it got', async () => {
  const area = fakeArea();
  const store = createStore(area);
  await store.ingest([parsed()], VIEWER);

  const result = await store.noteHistory(VIEWER, 't1', { at: 1754500000000, hasOlder: false });
  assert.deepEqual(result, { found: true });
  const [t] = await store.listThreads(VIEWER);
  assert.equal(t.historyAt, 1754500000000);
  assert.equal(t.historyOlder, false);
});

test('noteHistory says so when the history is only partly loaded', async () => {
  // A conversation that hit the page cap or a rate limit is NOT done, and the
  // next pass has to know that from the row alone.
  const area = fakeArea();
  const store = createStore(area);
  await store.ingest([parsed()], VIEWER);

  await store.noteHistory(VIEWER, 't1', { at: 1754500000000, hasOlder: true });
  const [t] = await store.listThreads(VIEWER);
  assert.equal(t.historyOlder, true);
});

test('noteHistory on a thread that is not stored says so instead of inventing a row', async () => {
  const store = createStore(fakeArea());
  assert.deepEqual(await store.noteHistory(VIEWER, 'ghost', { at: 1, hasOlder: false }), { found: false });
});
