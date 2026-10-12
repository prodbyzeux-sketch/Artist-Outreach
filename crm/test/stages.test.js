import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STAGES, DEFAULT_STAGE, PIPELINE, OUTCOMES, stageIndex, stageOf, stageLabel, filterThreads, countByStage,
} from '../lib/stages.js';

const thread = (over = {}) => ({
  threadID: 't1',
  username: 'drzybeats',
  displayName: 'DRZY Beats',
  lastMessage: 'which software fits him',
  ...over,
});

test('the pipeline is a fixed, ordered list with unique ids', () => {
  const ids = STAGES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids[0], DEFAULT_STAGE, 'a thread nobody touched sits at the start of the pipeline');
  assert.equal(STAGES.every((s) => s.label.length > 0), true);
});

test('the pipeline is what the track draws, and the outcomes are what sits beside it', () => {
  // The card draws PIPELINE as an ordered track and OUTCOMES as the two ways
  // out. Between them they have to be the whole funnel, or a stage exists that
  // no control can reach.
  assert.deepEqual([...PIPELINE, ...OUTCOMES].map((s) => s.id), STAGES.map((s) => s.id));
  assert.deepEqual(OUTCOMES.map((s) => s.id), ['won', 'lost']);
  assert.equal(stageIndex(DEFAULT_STAGE), 0);
  assert.equal(stageIndex('offer'), PIPELINE.length - 1);
  // A stopped conversation has no place on the track, so nothing on it is
  // marked — the card must not point at a step nobody is standing on.
  assert.equal(stageIndex('won'), -1);
});

test('a thread with no stage — or a stage nobody knows — reads as the first one', () => {
  // Stages arrive from the bridge too, and a command may carry anything.
  assert.equal(stageOf(thread()), DEFAULT_STAGE);
  assert.equal(stageOf(thread({ stage: 'nonsense' })), DEFAULT_STAGE);
  assert.equal(stageOf(thread({ stage: 'won' })), 'won');
  assert.equal(stageOf(undefined), DEFAULT_STAGE);
});

test('stageLabel names every stage and never returns a raw id', () => {
  assert.equal(stageLabel('won'), STAGES.find((s) => s.id === 'won').label);
  assert.equal(stageLabel('nonsense'), stageLabel(DEFAULT_STAGE));
});

test('no filters means the whole list, in the order it came', () => {
  const list = [thread(), thread({ threadID: 't2' })];
  assert.deepEqual(filterThreads(list, {}), list);
  assert.deepEqual(filterThreads(list, { query: '   ', stage: '' }), list);
});

test('filtering by stage counts an untouched thread as the first stage', () => {
  const list = [thread(), thread({ threadID: 't2', stage: 'won' })];
  assert.deepEqual(filterThreads(list, { stage: 'new' }).map((t) => t.threadID), ['t1']);
  assert.deepEqual(filterThreads(list, { stage: 'won' }).map((t) => t.threadID), ['t2']);
});

test('search reads the name, the handle, the last message, the note and the tags', () => {
  const list = [
    thread({ threadID: 'name', displayName: 'Namir Lucky', username: 'luckybeatsmx', lastMessage: 'hey' }),
    thread({ threadID: 'note', displayName: 'V', username: 'vescape', lastMessage: 'hey', note: 'созвон в понедельник' }),
    thread({ threadID: 'msg', displayName: 'Isombre', username: 'isombrebeats', lastMessage: 'india +5:30' }),
    thread({ threadID: 'tag', displayName: 'DRZY', username: 'drzybeats', lastMessage: 'hey', tags: ['usa', 'trap'] }),
  ];
  const ids = (query) => filterThreads(list, { query }).map((t) => t.threadID);
  assert.deepEqual(ids('namir'), ['name'], 'display name, case-insensitive');
  assert.deepEqual(ids('@luckybeatsmx'), ['name'], 'a handle typed with the @');
  assert.deepEqual(ids('  ПОНЕДЕЛЬНИК '), ['note'], 'the note, trimmed and case-folded in Russian too');
  assert.deepEqual(ids('india'), ['msg']);
  assert.deepEqual(ids('trap'), ['tag'], 'a tag the operator put there');
  assert.deepEqual(ids('zzz'), []);
});

test('stage and search apply together', () => {
  const list = [
    thread({ threadID: 'a', username: 'drzybeats', stage: 'pitched' }),
    thread({ threadID: 'b', username: 'drzyother', stage: 'won' }),
  ];
  assert.deepEqual(filterThreads(list, { query: 'drzy', stage: 'won' }).map((t) => t.threadID), ['b']);
});

test('the due filter is about the day, and stacks with the rest', () => {
  const now = new Date(2026, 7, 8, 10, 0).getTime();
  const endOf = (iso) => new Date(`${iso}T23:59:00`).getTime();
  const threads = [
    { threadID: 'a', username: 'drzybeats', stage: 'pitched', followUpAt: endOf('2026-08-07') },
    { threadID: 'b', username: 'isombrebeats', stage: 'offer', followUpAt: endOf('2026-08-08') },
    { threadID: 'c', username: 'ghostpiano', stage: 'pitched', followUpAt: endOf('2026-08-30') },
    { threadID: 'd', username: 'nobody', stage: 'pitched' },
  ];
  assert.deepEqual(filterThreads(threads, { due: true, now }).map((t) => t.threadID), ['a', 'b']);
  assert.deepEqual(filterThreads(threads, { due: true, stage: 'pitched', now }).map((t) => t.threadID), ['a']);
  assert.equal(filterThreads(threads, { due: false, now }).length, 4, 'off, it hides nothing');
});

test('countByStage counts every stage, zeros included', () => {
  const counts = countByStage([thread(), thread({ threadID: 't2', stage: 'won' }), thread({ threadID: 't3' })]);
  assert.equal(counts.new, 2);
  assert.equal(counts.won, 1);
  assert.equal(counts.lost, 0, 'an empty stage still has a number, so the filter can say so');
});
