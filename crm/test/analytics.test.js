import test from 'node:test';
import assert from 'node:assert/strict';

import { campaignStats, statHeadline, duration } from '../lib/analytics.js';

const HOUR = 3600000;
const NOON = 1786000000000;

// Three leads written to, one of them answered; one still queued; one tombstoned.
const leads = [
  { id: '1', handle: 'drzybeats', status: 'sent', ts: NOON, threadId: 't1' },
  { id: '2', handle: '@LuckyBeatsMX', status: 'sent', ts: NOON, threadId: 't2' },
  { id: '3', handle: 'isombrebeats', status: 'pending' },
  { id: '4', handle: 'goneguy', status: 'sent', ts: NOON, threadId: 't4', removed: true },
];

const inbox = {
  t1: { threadId: 't1', username: 'drzybeats', replied: true, firstReplyMs: NOON + 2 * HOUR },
  t2: { threadId: 't2', username: 'luckybeatsmx', replied: false, firstReplyMs: 0 },
};

const threads = [
  { threadID: 'a', username: 'drzybeats', stage: 'pitched' },
  { threadID: 'b', username: 'LuckyBeatsMX' },
];

const stats = () => campaignStats({ leads, inbox, threads, scanned: true });

test('the headline counts the table, the sends and the answers', () => {
  const s = stats();
  assert.equal(s.leads, 3, 'the removed lead is out of the table');
  assert.equal(s.sent, 2);
  assert.equal(s.replied, 1);
  assert.equal(s.rate, 0.5);
  assert.equal(s.medianReplyLagMs, 2 * HOUR);
});

test('a removed lead counts for nothing, sent or not', () => {
  // Removal is a tombstone rather than a splice, so a re-import cannot bring the
  // lead back — and a list you deleted must stop filling these numbers.
  const only = campaignStats({ leads: [leads[3]], inbox, threads: [], scanned: true });
  assert.equal(only.leads, 0);
  assert.equal(only.sent, 0);
});

test('replies are unknown, not zero, until the inbox has been read', () => {
  // "0 replied" and "nobody has looked" are different claims, and the second one
  // is the truth before the first run scans the inbox.
  const s = campaignStats({ leads, inbox: {}, threads, scanned: false });
  assert.equal(s.sent, 2, 'sends are known from the table alone');
  assert.equal(s.replied, null);
  assert.equal(s.rate, null);
  assert.equal(s.medianReplyLagMs, null);
});

test('captured counts the sends that have a conversation here', () => {
  // Most of a campaign is not in the inbox: Instagram hands back the recent
  // threads, not all of them. Saying so is the difference between "the capture
  // is partial" and "the campaign did nothing".
  assert.equal(stats().captured, 2);
  assert.equal(campaignStats({ leads, inbox, threads: [threads[0]], scanned: true }).captured, 1);
});

test('captured matches the handle exactly', () => {
  const near = [{ threadID: 'x', username: 'drzy' }, { threadID: 'y', username: 'drzybeats2' }];
  assert.equal(campaignStats({ leads, inbox, threads: near, scanned: true }).captured, 0);
});

test('the funnel counts the campaign conversations, not the whole inbox', () => {
  const s = stats();
  assert.equal(s.stages.pitched, 1);
  assert.equal(s.stages.new, 1, 'a thread nobody staged sits at the head of the funnel');
  assert.equal(s.stages.won, 0);
});

test('the collapsed line says what the campaign is, in one breath', () => {
  assert.equal(statHeadline(stats()), '3 leads · 2 sent · 1 replied · 50%');
});

test('one lead is a lead', () => {
  const s = campaignStats({ leads: [leads[0]], inbox, threads: [], scanned: true });
  assert.equal(statHeadline(s), '1 lead · 1 sent · 1 replied · 100%');
});

test('the collapsed line refuses to imply a rate it does not have', () => {
  const s = campaignStats({ leads, inbox: {}, threads, scanned: false });
  assert.equal(statHeadline(s), '3 leads · 2 sent · replies not read yet');
});

test('a duration is rounded to the unit a person would say it in', () => {
  assert.equal(duration(null), '—');
  assert.equal(duration(45 * 1000), 'under a minute');
  assert.equal(duration(9 * 60000), '9m');
  assert.equal(duration(2 * HOUR), '2h');
  assert.equal(duration(50 * HOUR), '2d');
});

test('an empty campaign answers with zeroes rather than throwing', () => {
  const s = campaignStats({});
  assert.deepEqual(
    { leads: s.leads, sent: s.sent, captured: s.captured, threads: s.threads },
    { leads: 0, sent: 0, captured: 0, threads: 0 },
  );
  assert.equal(s.replied, null);
});
