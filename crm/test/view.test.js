import test from 'node:test';
import assert from 'node:assert/strict';

import { sinceLabel, previewLine } from '../page/view.js';

const NOW = Date.UTC(2026, 7, 8, 12, 0, 0);
const MINUTE = 60000, HOUR = 3600000, DAY = 86400000;

test('a moment ago is a phrase, not a token with "ago" bolted on', () => {
  // The bug this replaces: the templates read `${relativeTime(at)} ago`, and
  // three of that function's five answers are not durations — the topbar said
  // "updated now ago" for anything inside a minute.
  assert.equal(sinceLabel(NOW - 20000, NOW), 'just now');
  assert.equal(sinceLabel(NOW - 4 * MINUTE, NOW), '4m ago');
  assert.equal(sinceLabel(NOW - 3 * HOUR, NOW), '3h ago');
});

test('past a day it names the day instead of counting hours', () => {
  assert.equal(sinceLabel(NOW - 30 * HOUR, NOW), 'yesterday');
  assert.match(sinceLabel(NOW - 9 * DAY, NOW), /^on \w/);
});

test('the preview says whose the last word was', () => {
  assert.deepEqual(previewLine({ lastMessage: 'ok sounds good', lastOutbound: true }), { mine: true, text: 'ok sounds good' });
  assert.deepEqual(previewLine({ lastMessage: 'how much', lastOutbound: false }), { mine: false, text: 'how much' });
  // Rows captured before the field existed: no claim rather than a wrong one.
  assert.equal(previewLine({ lastMessage: 'who is this' }).mine, false);
});

test('the preview still translates a message that is not words', () => {
  assert.equal(previewLine({ lastMessage: '[voice]', lastOutbound: true }).text, 'voice message');
  assert.equal(previewLine({ lastMessage: '' }).text, '—');
  assert.equal(previewLine(undefined).text, '—');
});

test('nothing to report reads as nothing at all', () => {
  // The topbar prints "updated <this>" — an empty string leaves the word off,
  // where a "never" would put a claim on screen about a state nobody is in yet.
  assert.equal(sinceLabel(0, NOW), '');
  assert.equal(sinceLabel(undefined, NOW), '');
});
