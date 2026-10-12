import test from 'node:test';
import assert from 'node:assert/strict';

import { createDrafts } from '../lib/drafts.js';

const A = 't-alice';
const B = 't-bob';

test('a half-written reply comes back to the conversation it was typed in', () => {
  const drafts = createDrafts();
  drafts.keep(A, 'yes, $150 lifetime');
  drafts.keep(B, 'who is this');
  assert.equal(drafts.textFor(A), 'yes, $150 lifetime');
  assert.equal(drafts.textFor(B), 'who is this');
});

test('a conversation nobody has typed in holds no draft', () => {
  const drafts = createDrafts();
  assert.equal(drafts.textFor(A), '', 'so the composer is emptied, not left with somebody else\'s text');
});

test('an empty composer is not kept as a draft', () => {
  const drafts = createDrafts();
  drafts.keep(A, '');
  drafts.keep(B, '  \n ');
  assert.equal(drafts.textFor(A), '');
  assert.equal(drafts.textFor(B), '', 'whitespace alone is nothing to come back to');
});

test('clearing the composer drops the draft that was there', () => {
  const drafts = createDrafts();
  drafts.keep(A, 'sent this already');
  drafts.keep(A, '');
  assert.equal(drafts.textFor(A), '');
});

test('a draft is kept exactly as it was typed', () => {
  const drafts = createDrafts();
  drafts.keep(A, ' two lines\n\nand a space ');
  assert.equal(drafts.textFor(A), ' two lines\n\nand a space ');
});

// ── whose text is in the box: the bridge's own, or a person's ──────────────

test('the bridge may write where nothing is waiting', () => {
  const drafts = createDrafts();
  assert.equal(drafts.isFree(A), true);
});

test('the bridge may replace a draft it placed itself', () => {
  const drafts = createDrafts();
  drafts.place(A, 'da, prodayu');
  assert.equal(drafts.isFree(A), true);
  drafts.place(A, 'yes, selling — $150');
  assert.equal(drafts.textFor(A), 'yes, selling — $150');
});

test('the bridge may not overwrite what a person typed', () => {
  const drafts = createDrafts();
  drafts.keep(A, 'hey man, let me think');
  assert.equal(drafts.isFree(A), false);
});

test('a placed draft a person edited becomes theirs', () => {
  const drafts = createDrafts();
  drafts.place(A, 'yes, $150');
  drafts.keep(A, 'yes, $150 — and stems included');
  assert.equal(drafts.isFree(A), false, 'the sentence they are in the middle of is not the bridge\'s to replace');
});

test('a placed draft waits in its own conversation like any other', () => {
  const drafts = createDrafts();
  drafts.place(A, 'yes, $150');
  assert.equal(drafts.textFor(A), 'yes, $150', 'so leaving and coming back does not lose it');
});

test('one conversation being busy says nothing about another', () => {
  const drafts = createDrafts();
  drafts.place(A, 'yes, $150');
  drafts.keep(B, 'no thanks');
  assert.equal(drafts.isFree(A), true);
  assert.equal(drafts.isFree(B), false, 'the answer is about the thread asked for, not the one on screen');
});

test('deleting a placed draft hands the box back to the bridge', () => {
  const drafts = createDrafts();
  drafts.place(A, 'yes, $150');
  drafts.keep(A, '');
  assert.equal(drafts.isFree(A), true);
});

test('whitespace left in the box does not block the bridge forever', () => {
  const drafts = createDrafts();
  drafts.keep(A, '   ');
  assert.equal(drafts.isFree(A), true);
});

test('two conversations keep their own drafts through a swap', () => {
  // The bug this is about: the composer is one box for every conversation, so
  // leaving one without putting the text somewhere sends it to the next person.
  const drafts = createDrafts();
  drafts.keep(A, 'for alice');
  drafts.keep(B, 'for bob');
  assert.equal(drafts.textFor(A), 'for alice');
  drafts.keep(A, 'for alice, longer');
  assert.equal(drafts.textFor(B), 'for bob', 'untouched by what happens in the other one');
});
