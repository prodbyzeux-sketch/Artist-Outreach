import test from 'node:test';
import assert from 'node:assert/strict';

import { matchesSource, pickSnapshot, describeSource, countUnroutable, addressedTo } from '../lib/routing.js';

const POLINA = { sourceId: 's-polina', viewer: { fbid: '900', username: 'praypolina' } };
const ANGEL = { sourceId: 's-angel', viewer: { fbid: '700', username: 'prayangelica' } };

test('a command addressed to an account reaches only that CRM', () => {
  const cmd = { account: 'prayangelica' };
  assert.equal(matchesSource(cmd, ANGEL), true);
  assert.equal(matchesSource(cmd, POLINA), false);
});

test('an account can be named by username or by fbid, case-insensitively and with @', () => {
  assert.equal(matchesSource({ account: '@PrayAngelica' }, ANGEL), true);
  assert.equal(matchesSource({ account: '700' }, ANGEL), true);
  assert.equal(matchesSource({ account: '700' }, POLINA), false);
});

test('a command addressed to a source reaches that browser profile only', () => {
  assert.equal(matchesSource({ source: 's-polina' }, POLINA), true);
  assert.equal(matchesSource({ source: 's-polina' }, ANGEL), false);
});

test('an unaddressed command reaches nobody', () => {
  // Two profiles poll the same daemon. A command with no target would be taken
  // by whichever asked first and applied to the wrong account — so it is never
  // handed out; /commands refuses it at the door.
  assert.equal(matchesSource({}, POLINA), false);
  assert.equal(matchesSource({ account: '' }, POLINA), false);
});

test('a CRM that has not captured an account yet only gets source-addressed commands', () => {
  const fresh = { sourceId: 's-new', viewer: null };
  assert.equal(matchesSource({ account: 'prayangelica' }, fresh), false);
  assert.equal(matchesSource({ source: 's-new' }, fresh), true);
});

// ── choosing which snapshot to read ────────────────────────────────────────

const snapshots = {
  's-polina': { ...POLINA, capturedAt: 100, threadCount: 339 },
  's-angel': { ...ANGEL, capturedAt: 200, threadCount: 1083 },
};

test('with one CRM connected, no query is needed', () => {
  const only = { 's-angel': snapshots['s-angel'] };
  assert.equal(pickSnapshot(only, {}).snapshot.threadCount, 1083);
});

test('an account or source query picks the right one', () => {
  assert.equal(pickSnapshot(snapshots, { account: 'praypolina' }).snapshot.threadCount, 339);
  assert.equal(pickSnapshot(snapshots, { source: 's-angel' }).snapshot.threadCount, 1083);
});

test('an ambiguous read fails loudly instead of guessing', () => {
  // Returning "the newest" here is how you analyse one account and think you
  // analysed the other.
  const result = pickSnapshot(snapshots, {});
  assert.equal(result.snapshot, null);
  assert.equal(result.error, 'ambiguous');
  assert.deepEqual(result.choices.map((c) => c.account), ['prayangelica', 'praypolina']);
});

test('asking for an account nobody is logged into says so', () => {
  const result = pickSnapshot(snapshots, { account: 'nobody' });
  assert.equal(result.snapshot, null);
  assert.equal(result.error, 'no such account');
});

test('reading before any CRM has synced says so', () => {
  assert.equal(pickSnapshot({}, {}).error, 'no snapshot yet');
});

// ── commands nobody will ever take ─────────────────────────────────────────

test('a command no connected CRM matches is counted, not left invisible', () => {
  // A typo in the account name queues a command forever: the CRM it was meant
  // for never sees it, so its own "queued" badge stays at zero and nothing on
  // this machine says the command exists.
  const queue = [
    { account: 'prayangelica' },
    { account: 'prayangelika' }, // typo
    { source: 's-gone' },        // a profile that no longer polls
  ];
  assert.equal(countUnroutable(queue, snapshots), 2);
});

test('nothing is unroutable when nothing is queued, or when every target is live', () => {
  assert.equal(countUnroutable([], snapshots), 0);
  assert.equal(countUnroutable([{ source: 's-angel' }], snapshots), 0);
});

test('with no CRM connected every queued command is unroutable', () => {
  // Not an error: the daemon may simply have started first.
  assert.equal(countUnroutable([{ account: 'prayangelica' }], {}), 1);
});

test('forgetting an address reaches the commands sent to it, snapshot or not', () => {
  // The account with the typo has no snapshot by definition — matching through
  // one would make exactly the stuck command impossible to clear.
  assert.equal(addressedTo({ account: 'prayangelika' }, { account: '@PrayAngelika' }), true);
  assert.equal(addressedTo({ account: 'prayangelica' }, { account: 'prayangelika' }), false);
  assert.equal(addressedTo({ source: 's-gone' }, { source: 's-gone' }), true);
  assert.equal(addressedTo({ account: 'prayangelica' }, {}), false, 'an empty target forgets nothing');
});

test('sources are described by account, falling back to the source id', () => {
  assert.equal(describeSource(ANGEL).account, 'prayangelica');
  assert.equal(describeSource({ sourceId: 's-new', viewer: null }).account, null);
  assert.equal(describeSource({ sourceId: 's-new', viewer: null }).sourceId, 's-new');
});
