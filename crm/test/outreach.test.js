import test from 'node:test';
import assert from 'node:assert/strict';

import { indexLeads, leadFor, threadsForLeads, indexTables } from '../lib/outreach.js';

const leads = [
  { id: '1', handle: 'drzybeats', status: 'sent', ts: 1786000000000 },
  { id: '2', handle: '@LuckyBeatsMX', status: 'pending' },
  { id: '3', handle: '  isombrebeats  ', status: 'failed', error: 'no such account' },
];

test('a lead is found by handle however it was typed into the table', () => {
  const index = indexLeads(leads);
  assert.equal(leadFor(index, 'drzybeats')?.id, '1');
  assert.equal(leadFor(index, '@drzybeats')?.id, '1');
  assert.equal(leadFor(index, 'luckybeatsmx')?.id, '2', 'the table had it capitalised and with an @');
  assert.equal(leadFor(index, 'isombrebeats')?.id, '3', 'the table had it padded with spaces');
});

test('the match is exact — never a substring', () => {
  // A lead table with "drzy" must not claim the thread with "drzybeats": one
  // wrong match here tells the operator they already messaged someone they did not.
  const index = indexLeads(leads);
  assert.equal(leadFor(index, 'drzy'), null);
  assert.equal(leadFor(index, 'drzybeats2'), null);
  assert.equal(leadFor(index, 'beats'), null);
});

test('nothing to match against gives nothing back', () => {
  assert.equal(leadFor(indexLeads(leads), ''), null);
  assert.equal(leadFor(indexLeads(leads), undefined), null);
  assert.equal(leadFor(indexLeads(undefined), 'drzybeats'), null);
  assert.equal(indexLeads(null).size, 0);
});

test('rows without a handle are skipped, not indexed as empty', () => {
  const index = indexLeads([{ id: 'x', status: 'sent' }, { id: 'y', handle: '   ', status: 'sent' }]);
  assert.equal(index.size, 0);
});

test('the campaign inbox is the conversations that are in its table', () => {
  const index = indexLeads(leads);
  const threads = [
    { threadID: 'a', username: 'DRZYbeats' },
    { threadID: 'b', username: 'somebody-else' },
    { threadID: 'c', username: 'isombrebeats' },
    { threadID: 'd' }, // a group chat with no single counterpart
  ];
  assert.deepEqual(threadsForLeads(threads, index).map((t) => t.threadID), ['a', 'c']);
  assert.deepEqual(threadsForLeads(threads, indexLeads([])), []);
  assert.deepEqual(threadsForLeads(null, index), []);
});

test('a lead stays found after the operator switches campaigns', () => {
  // "Have I written to this person" does not stop being true because they are
  // on another list — the card reads every table, the funnel only the open one.
  const ru = { id: 'c_1', name: 'Producers RU' };
  const us = { id: 'c_2', name: 'Producers US' };
  const index = indexTables([
    { campaign: ru, leads: [{ id: '1', handle: 'drzybeats', status: 'sent' }] },
    { campaign: us, leads: [{ id: '2', handle: 'isombrebeats', status: 'failed' }] },
  ]);
  assert.equal(leadFor(index, 'isombrebeats').campaign.name, 'Producers US');
  assert.equal(leadFor(index, 'drzybeats').status, 'sent');
  assert.equal(leadFor(index, 'nobody'), null);
});

test('the same handle on two lists is credited to the first list', () => {
  const index = indexTables([
    { campaign: { id: 'c_1', name: 'First' }, leads: [{ handle: 'drzybeats', status: 'sent' }] },
    { campaign: { id: 'c_2', name: 'Second' }, leads: [{ handle: 'drzybeats', status: 'pending' }] },
  ]);
  assert.equal(leadFor(index, 'drzybeats').campaign.name, 'First');
  assert.equal(indexTables(null).size, 0);
  assert.equal(indexTables([{ campaign: { id: 'c' }, leads: undefined }]).size, 0);
});

test('a handle listed twice keeps the first row', () => {
  const index = indexLeads([
    { id: 'first', handle: 'drzybeats', status: 'sent' },
    { id: 'second', handle: 'DRZYBEATS', status: 'failed' },
  ]);
  assert.equal(leadFor(index, 'drzybeats').id, 'first');
});
