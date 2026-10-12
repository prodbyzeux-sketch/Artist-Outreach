// The next step on a conversation, and how long it has sat where it is.
//
// A stage says where a lead stands; it does not say what to do on Thursday. The
// funnel without this is a set of labels nobody is asked to act on — the lead
// with an agreed call and the lead who went quiet look identical, and the list,
// sorted by last activity, hides exactly the ones nothing has happened to.
//
// Two facts, both cheap: a day to come back on, and how long the stage has held.
// Pure, so the list can be counted in a test rather than in a browser.

const DAY = 86400000;

/** How long a lead may sit in one stage before the list mentions it. */
export const STALE_DAYS = 7;

/** Neither end of the pipeline rots: they are finished, not waiting. */
const SETTLED = new Set(['new', 'won', 'lost']);

/**
 * A picked day means the END of that day. `new Date('2026-08-12')` is UTC
 * midnight, which west of Greenwich is already the 11th — a follow-up set for
 * Wednesday would come due on Tuesday. And the end rather than the start so that
 * something set for today is not overdue the moment it is set.
 */
export function dayInputToMs(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  const date = new Date(year, month - 1, day, 23, 59, 0, 0);
  // Rejects 2026-13-40, which the constructor would happily roll into 2027.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date.getTime();
}

const pad = (n) => String(n).padStart(2, '0');

/** Back into the date field, in the same timezone it was picked in. */
export function msToDayInput(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A preset button: N days out, landing on the end of that day like a picked one. */
export function plusDays(now, days) {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  d.setHours(23, 59, 0, 0);
  return d.getTime();
}

/** Whole days between two moments, by the calendar rather than by the clock. */
function daysBetween(from, to) {
  const a = new Date(from); a.setHours(0, 0, 0, 0);
  const b = new Date(to); b.setHours(0, 0, 0, 0);
  return Math.round((b.getTime() - a.getTime()) / DAY);
}

const MONTH_DAY = { day: 'numeric', month: 'short' };

/**
 * Near days are named, distant ones are dated: "in 34 days" is arithmetic the
 * reader has to undo before it means anything.
 */
export function followUpLabel(ms, now = Date.now()) {
  if (!ms) return '';
  const days = daysBetween(now, ms);
  if (days < 0) return `${-days} ${-days === 1 ? 'day' : 'days'} late`;
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days <= 14) return `in ${days} days`;
  return new Date(ms).toLocaleDateString('en-US', MONTH_DAY);
}

/**
 * Due when the DAY has arrived, not when the timestamp has passed. A follow-up
 * set for today is work for today — it must be on the list all morning, not
 * appear at 23:59 and be overdue a minute later.
 */
/** The same fact for a list row, where the name has first claim on the width. */
export function followUpShort(ms, now = Date.now()) {
  if (!ms) return '';
  const days = daysBetween(now, ms);
  return days < 0 ? `${-days}d late` : days === 0 ? 'today' : followUpLabel(ms, now);
}

export const isDue = (thread, now = Date.now()) =>
  Boolean(thread?.followUpAt) && daysBetween(now, thread.followUpAt) <= 0;

export const dueCount = (threads, now = Date.now()) =>
  (threads ?? []).filter((t) => isDue(t, now)).length;

/**
 * Days in the current stage, or null when the number would not mean anything:
 * nobody moved it, the move predates the field, or the lead is done. Null and
 * not 0 — a zero here reads as "moved just now", which is a different claim.
 */
export function stageAgeDays(thread, now = Date.now()) {
  const stage = thread?.stage;
  if (!stage || SETTLED.has(stage) || !thread?.stageChangedAt) return null;
  return Math.max(0, daysBetween(thread.stageChangedAt, now));
}
