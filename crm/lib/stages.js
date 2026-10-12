// The funnel: the operator's own columns over Instagram's data. Pure, so the
// list can be filtered and counted in a test rather than in a browser.
//
// The pipeline is deliberately short and fixed. A configurable one would need a
// stage editor, a migration for renamed stages and a story for orphaned rows —
// none of which sells anything.

import { isDue } from './followup.js';

export const STAGES = [
  { id: 'new', label: 'New' },
  { id: 'talking', label: 'Talking' },
  { id: 'pitched', label: 'Pitched' },
  { id: 'offer', label: 'Offer' },
  // Where a conversation stops, not a place it passes through. The card shows
  // these away from the track, which has no position to put them in.
  { id: 'won', label: 'Won', terminal: true },
  { id: 'lost', label: 'Lost', terminal: true },
];

export const DEFAULT_STAGE = STAGES[0].id;

/** The ordered part of the funnel, and the two ways out of it. */
export const PIPELINE = STAGES.filter((s) => !s.terminal);
export const OUTCOMES = STAGES.filter((s) => s.terminal);

/** How far along the pipeline a stage sits; -1 once the conversation has stopped. */
export const stageIndex = (id) => PIPELINE.findIndex((s) => s.id === id);

const byID = new Map(STAGES.map((s) => [s.id, s]));

/** A row's stage, forced into the pipeline: patches arrive from the bridge. */
export const stageOf = (thread) => (byID.has(thread?.stage) ? thread.stage : DEFAULT_STAGE);

export const stageLabel = (id) => (byID.get(id) ?? byID.get(DEFAULT_STAGE)).label;

const haystack = (t) => [t.displayName, t.username, t.lastMessage, t.note, ...(t.tags ?? [])]
  .filter(Boolean)
  .join(' ')
  .toLowerCase();

/** Search covers what the operator can see plus their own note and tags. */
export function filterThreads(threads, { query = '', stage = '', due = false, now = Date.now() } = {}) {
  const needle = String(query).trim().replace(/^@/, '').toLowerCase();
  return (threads ?? []).filter((t) => {
    if (due && !isDue(t, now)) return false;
    if (stage && stageOf(t) !== stage) return false;
    return !needle || haystack(t).includes(needle);
  });
}

export function countByStage(threads) {
  const counts = Object.fromEntries(STAGES.map((s) => [s.id, 0]));
  for (const t of threads ?? []) counts[stageOf(t)]++;
  return counts;
}
