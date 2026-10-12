import test from 'node:test';
import assert from 'node:assert/strict';

import { nextPick, prunePicked } from '../lib/selection.js';

const ids = ['a', 'b', 'c', 'd', 'e'];
const set = (...members) => new Set(members);
const of = (result) => [...result.picked];

test('a plain click drops the selection — it is a click, not a pick', () => {
  const result = nextPick({ picked: set('a', 'b'), anchor: 'a', ids, id: 'd', mode: 'only' });
  assert.deepEqual(of(result), []);
  assert.equal(result.anchor, 'd', 'and it becomes the point a later shift-click counts from');
});

test('a modifier click toggles one row and leaves the rest', () => {
  assert.deepEqual(of(nextPick({ picked: set(), anchor: null, ids, id: 'b', mode: 'toggle' })), ['b']);
  assert.deepEqual(of(nextPick({ picked: set('a', 'b'), anchor: 'a', ids, id: 'b', mode: 'toggle' })), ['a']);
  assert.equal(nextPick({ picked: set(), anchor: null, ids, id: 'b', mode: 'toggle' }).anchor, 'b');
});

test('shift takes the run between the anchor and the row, either way round', () => {
  assert.deepEqual(of(nextPick({ picked: set('b'), anchor: 'b', ids, id: 'd', mode: 'range' })), ['b', 'c', 'd']);
  assert.deepEqual(of(nextPick({ picked: set('d'), anchor: 'd', ids, id: 'b', mode: 'range' })), ['d', 'b', 'c']);
  assert.deepEqual(of(nextPick({ picked: set('b'), anchor: 'b', ids, id: 'b', mode: 'range' })), ['b']);
});

test('a run adds to what is already picked rather than replacing it', () => {
  // Two runs from opposite ends of the list is the ordinary way a person builds
  // one of these, and it must not cost them the first run.
  const result = nextPick({ picked: set('a'), anchor: 'c', ids, id: 'd', mode: 'range' });
  assert.deepEqual(of(result).sort(), ['a', 'c', 'd']);
  assert.equal(result.anchor, 'c', 'the anchor stays put, so the run can be stretched again');
});

test('shift with nothing to count from picks the one row', () => {
  assert.deepEqual(of(nextPick({ picked: set(), anchor: null, ids, id: 'c', mode: 'range' })), ['c']);
  // The anchor scrolled out of the filter: there is no run to take, so it is the
  // start of a new one rather than a silently empty gesture.
  assert.deepEqual(of(nextPick({ picked: set(), anchor: 'gone', ids, id: 'c', mode: 'range' })), ['c']);
});

test('rows that left the list leave the selection with them', () => {
  // Otherwise a filter hides four of five picked rows and the next bulk action
  // lands on conversations nobody can see.
  assert.deepEqual([...prunePicked(set('a', 'c', 'x'), ids)], ['a', 'c']);
  assert.deepEqual([...prunePicked(set('x'), ids)], []);
});

test('nothing to prune gives the same set back, so the caller can skip the repaint', () => {
  const picked = set('a', 'c');
  assert.equal(prunePicked(picked, ids), picked);
  const empty = set();
  assert.equal(prunePicked(empty, ids), empty);
});
