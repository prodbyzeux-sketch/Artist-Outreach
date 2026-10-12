import test from 'node:test';
import assert from 'node:assert/strict';

import { addTags, removeTag, normalizeTags } from '../lib/tags.js';

test('a tag is trimmed, and a lone # is not part of it', () => {
  assert.deepEqual(addTags([], '  #usa '), ['usa']);
});

test('one field can carry several tags', () => {
  assert.deepEqual(addTags([], 'usa, trap , #drill'), ['usa', 'trap', 'drill']);
});

test('nothing to add leaves the very same array', () => {
  const tags = ['usa'];
  assert.equal(addTags(tags, '   '), tags, 'identity, so the caller can skip the write');
  assert.equal(addTags(tags, ',,,'), tags);
  assert.equal(addTags(tags, 'USA'), tags, 'already there, in another case');
});

test('a duplicate never lands twice, whatever the case', () => {
  assert.deepEqual(addTags(['usa'], 'Usa, trap'), ['usa', 'trap']);
  assert.deepEqual(addTags([], 'trap, TRAP'), ['trap'], 'inside one input too');
});

test('a tag stays short enough to read in a chip', () => {
  const long = 'a'.repeat(40);
  const [tag] = addTags([], long);
  assert.equal(tag.length, 24);
});

test('inner whitespace collapses instead of making two tags', () => {
  assert.deepEqual(addTags([], 'east  coast'), ['east coast']);
});

test('removing works by name, in any case, and only on what is there', () => {
  assert.deepEqual(removeTag(['usa', 'trap'], 'USA'), ['trap']);
  const tags = ['usa'];
  assert.equal(removeTag(tags, 'drill'), tags, 'nothing removed — nothing to write');
});

test('a missing tag list is treated as an empty one', () => {
  assert.deepEqual(addTags(undefined, 'usa'), ['usa']);
  assert.deepEqual(removeTag(undefined, 'usa'), []);
});

// ── a whole list arriving from outside ────────────────────────────────────

test('a list from the bridge is cleaned by the same rules as typing', () => {
  assert.deepEqual(normalizeTags(['  #usa ', 'east  coast']), ['usa', 'east coast']);
  assert.deepEqual(normalizeTags(['trap', 'TRAP']), ['trap']);
  assert.equal(normalizeTags(['a'.repeat(40)])[0].length, 24);
});

test('a list that is not a list of strings is refused, not coerced', () => {
  // Coercing gives the sender a success for something they did not ask for, and
  // `tags: 42` in storage is what breaks every later render of the list.
  assert.equal(normalizeTags(42), null);
  assert.equal(normalizeTags('warm'), null);
  assert.equal(normalizeTags([1, 2]), null);
  assert.equal(normalizeTags(null), null);
});

test('an empty list is a legitimate list — it clears the tags', () => {
  assert.deepEqual(normalizeTags([]), []);
  assert.deepEqual(normalizeTags(['  ', '#']), [], 'nothing survives cleaning, and that is still a clear');
});
