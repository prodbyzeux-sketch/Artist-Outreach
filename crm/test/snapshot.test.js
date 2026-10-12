import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSnapshot, isSnapshotKey } from '../lib/snapshot.js';

test('the snapshot knows which storage keys are its own', () => {
  // The send run writes to this same storage; a push on every one of its writes
  // would mean the whole inbox on the wire every second and a half.
  assert.equal(isSnapshotKey('threads'), true);
  assert.equal(isSnapshotKey('viewer'), true);
  assert.equal(isSnapshotKey('health'), true);
  assert.equal(isSnapshotKey('msg:178|340282'), true);
  assert.equal(isSnapshotKey('folders'), true, 'or a row travels with a folder id nothing can name');
  assert.equal(isSnapshotKey('runState'), false, "the run's own state");
  assert.equal(isSnapshotKey('leads'), false);
  assert.equal(isSnapshotKey('bridgeSource'), false, 'our own id — pushing on it would loop');
  assert.equal(isSnapshotKey('tpl'), false, 'never leaves the browser at all');
});

const VIEWER = '900';

function dump(over = {}) {
  return {
    viewer: { fbid: VIEWER, username: 'me' },
    health: { lastSuccessAt: 1234 },
    tpl: { url: 'https://www.instagram.com/api/graphql', body: 'x=1', headers: { cookie: 'sessionid=SECRET' } },
    tplPage: { headers: { 'x-ig-app-id': '936619743392459' } },
    tplThread: { url: 'https://www.instagram.com/api/v1/direct_v2/threads/1/', headers: { authorization: 'Bearer SECRET2' } },
    threads: [
      { threadID: 't1', viewerFbid: VIEWER, username: 'lead_one', lastActivityAt: 2000, messageCount: 2, replied: true, needsAttention: true, stage: 'interested' },
      { threadID: 't2', viewerFbid: VIEWER, username: 'lead_two', lastActivityAt: 1000, messageCount: 1, replied: false, needsAttention: false },
    ],
    [`msg:${VIEWER}|t1`]: [
      { id: 'm1', direction: 'out', text: 'hey', timestamp: 1000 },
      { id: 'm2', direction: 'in', text: 'hi back', timestamp: 2000 },
    ],
    [`msg:${VIEWER}|t2`]: [{ id: 'm3', direction: 'out', text: 'opener', timestamp: 1000 }],
    ...over,
  };
}

test('a snapshot pairs every thread row with its messages', () => {
  const snap = buildSnapshot(dump());
  assert.equal(snap.viewer.username, 'me');
  assert.equal(snap.threads.length, 2);
  assert.deepEqual(snap.threads.map((t) => t.threadID), ['t1', 't2']);
  assert.deepEqual(snap.threads[0].messages.map((m) => m.text), ['hey', 'hi back']);
  assert.equal(snap.threads[0].stage, 'interested', 'CRM fields travel with the row');
});

test('the replay template never leaves the browser', () => {
  // tpl holds the live Instagram request: cookies, tokens, app id. It is the one
  // thing in storage that would let anything outside the browser act as the user.
  const snap = buildSnapshot(dump());
  const serialized = JSON.stringify(snap);
  assert.ok(!serialized.includes('SECRET'), 'session cookie must not be in the snapshot');
  assert.ok(!serialized.includes('936619743392459'));
  assert.ok(!serialized.includes('SECRET2'), 'the thread request carries auth headers too');
  assert.equal(snap.tpl, undefined);
  assert.equal(snap.tplPage, undefined);
  assert.equal(snap.tplThread, undefined);
});

test('threads are ordered newest first and carry a count', () => {
  const snap = buildSnapshot(dump({
    threads: [
      { threadID: 'old', viewerFbid: VIEWER, lastActivityAt: 10 },
      { threadID: 'new', viewerFbid: VIEWER, lastActivityAt: 99 },
    ],
  }));
  assert.deepEqual(snap.threads.map((t) => t.threadID), ['new', 'old']);
  assert.equal(snap.threadCount, 2);
});

test('only the logged-in account is exported', () => {
  const raw = dump();
  raw.threads.push({ threadID: 'x1', viewerFbid: '777', username: 'other_account' });
  raw['msg:777|x1'] = [{ id: 'z', direction: 'in', text: 'not mine', timestamp: 1 }];

  const snap = buildSnapshot(raw);
  assert.deepEqual(snap.threads.map((t) => t.username), ['lead_one', 'lead_two']);
});

test('a thread whose history has not been captured yet exports as empty, not missing', () => {
  const raw = dump();
  delete raw[`msg:${VIEWER}|t2`];
  const snap = buildSnapshot(raw);
  assert.deepEqual(snap.threads[1].messages, []);
});

test('an empty store still produces a valid snapshot', () => {
  const snap = buildSnapshot({});
  assert.deepEqual(snap.threads, []);
  assert.equal(snap.threadCount, 0);
  assert.equal(snap.viewer, null);
  assert.deepEqual(snap.folders, []);
});

test('the folder names travel with the ids the rows carry', () => {
  const snap = buildSnapshot(dump({
    folders: [{ id: 'f1', name: 'Warm' }],
    threads: [{ threadID: 't1', viewerFbid: VIEWER, lastActivityAt: 1, folderID: 'f1' }],
  }));
  assert.deepEqual(snap.folders, [{ id: 'f1', name: 'Warm' }]);
  assert.equal(snap.threads[0].folderID, 'f1');
});
