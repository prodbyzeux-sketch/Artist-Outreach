import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dayInputToMs, msToDayInput, plusDays, followUpLabel, followUpShort, isDue, dueCount, stageAgeDays, STALE_DAYS,
} from '../lib/followup.js';

const DAY = 86400000;
// A fixed "now" so nothing here depends on the day the tests are run.
const NOW = new Date(2026, 7, 8, 14, 30).getTime(); // 8 Aug 2026, 14:30 local

// ── the date field ────────────────────────────────────────────────────────

test('a picked day means the end of that day, in the operator\'s own timezone', () => {
  // new Date('2026-08-12') is UTC midnight — west of Greenwich that is the 11th,
  // so a follow-up set for Wednesday would come due on Tuesday.
  const ms = dayInputToMs('2026-08-12');
  const d = new Date(ms);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 7);
  assert.equal(d.getDate(), 12);
  assert.equal(d.getHours(), 23, 'end of the day, so "today" is not overdue the moment it is set');
  assert.equal(d.getMinutes(), 59);
});

test('the field shows the day back, unchanged by the round trip', () => {
  assert.equal(msToDayInput(dayInputToMs('2026-08-12')), '2026-08-12');
  assert.equal(msToDayInput(NOW), '2026-08-08');
  assert.equal(msToDayInput(null), '', 'nothing set, nothing in the field');
});

test('an unparseable day is nothing, not a date in 1970', () => {
  assert.equal(dayInputToMs(''), null);
  assert.equal(dayInputToMs('tomorrow'), null);
  assert.equal(dayInputToMs('2026-13-40'), null);
});

test('the presets land on the end of a day too, not on this exact hour', () => {
  const tomorrow = new Date(plusDays(NOW, 1));
  assert.equal(tomorrow.getDate(), 9);
  assert.equal(tomorrow.getHours(), 23);
  assert.equal(new Date(plusDays(NOW, 7)).getDate(), 15);
});

// ── what it says ──────────────────────────────────────────────────────────

test('a follow-up reads as a plain day, and says when it is late', () => {
  assert.equal(followUpLabel(dayInputToMs('2026-08-08'), NOW), 'today');
  assert.equal(followUpLabel(dayInputToMs('2026-08-09'), NOW), 'tomorrow');
  assert.equal(followUpLabel(dayInputToMs('2026-08-11'), NOW), 'in 3 days');
  assert.equal(followUpLabel(dayInputToMs('2026-08-07'), NOW), '1 day late');
  assert.equal(followUpLabel(dayInputToMs('2026-08-01'), NOW), '7 days late');
  assert.equal(followUpLabel(null, NOW), '');
});

test('the list says the same thing in fewer characters', () => {
  // The row has a name to show first; a badge that pushes it down to "Drz…" has
  // taken more than it gives.
  assert.equal(followUpShort(dayInputToMs('2026-08-08'), NOW), 'today');
  assert.equal(followUpShort(dayInputToMs('2026-08-07'), NOW), '1d late');
  assert.equal(followUpShort(dayInputToMs('2026-08-01'), NOW), '7d late');
  assert.equal(followUpShort(null, NOW), '');
});

test('a distant follow-up is dated rather than counted', () => {
  // "in 34 days" is arithmetic the reader has to undo; a date is just read.
  assert.match(followUpLabel(dayInputToMs('2026-09-11'), NOW), /Sep 11/);
});

// ── due ───────────────────────────────────────────────────────────────────

test('due means the day has arrived, not that a date exists', () => {
  assert.equal(isDue({ followUpAt: dayInputToMs('2026-08-08') }, NOW), true, 'today counts');
  assert.equal(isDue({ followUpAt: dayInputToMs('2026-08-07') }, NOW), true);
  assert.equal(isDue({ followUpAt: dayInputToMs('2026-08-09') }, NOW), false);
  assert.equal(isDue({}, NOW), false, 'no follow-up is not an overdue one');
});

test('the badge counts conversations, not dates', () => {
  const threads = [
    { followUpAt: dayInputToMs('2026-08-07') },
    { followUpAt: dayInputToMs('2026-08-08') },
    { followUpAt: dayInputToMs('2026-08-20') },
    {},
  ];
  assert.equal(dueCount(threads, NOW), 2);
  assert.equal(dueCount([], NOW), 0);
});

// ── how long it has sat there ─────────────────────────────────────────────

test('stage age is counted from the move, not from the last message', () => {
  // The point of the number is the opposite of activity: a lead that has been in
  // Pitched for three weeks is quiet, and quiet is what the list hides.
  assert.equal(stageAgeDays({ stage: 'pitched', stageChangedAt: NOW - 12 * DAY }, NOW), 12);
  assert.equal(stageAgeDays({ stage: 'pitched', stageChangedAt: NOW - 0.5 * DAY }, NOW), 0);
});

test('no stage and no move mean no age — not zero days, which reads as "just now"', () => {
  assert.equal(stageAgeDays({ stage: 'pitched' }, NOW), null, 'set before the field existed');
  assert.equal(stageAgeDays({ stageChangedAt: NOW - 9 * DAY }, NOW), null, 'nobody moved it anywhere');
  assert.equal(stageAgeDays({ stage: 'new', stageChangedAt: NOW - 9 * DAY }, NOW), null, 'new is where everything starts');
});

test('won and lost do not rot — they are finished, not stalled', () => {
  assert.equal(stageAgeDays({ stage: 'won', stageChangedAt: NOW - 40 * DAY }, NOW), null);
  assert.equal(stageAgeDays({ stage: 'lost', stageChangedAt: NOW - 40 * DAY }, NOW), null);
});

test('a stale threshold exists so the list can stay quiet about a fresh move', () => {
  assert.ok(STALE_DAYS >= 3 && STALE_DAYS <= 14, 'a working week or so, not a quarter');
});
