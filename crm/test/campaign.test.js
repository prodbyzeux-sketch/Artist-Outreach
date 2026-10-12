import test from 'node:test';
import assert from 'node:assert/strict';

import { activeCampaign, leadsKey, isLeadsKey } from '../lib/campaign.js';

const campaigns = [
  { id: 'c_1', name: 'Producers RU', createdAt: 1 },
  { id: 'c_2', name: 'Producers US', createdAt: 2 },
];

test('the lead table lives under the campaign, never under a bare key', () => {
  // The outreach half migrates the unscoped `leads` key away the first time it
  // runs, so reading it comes back empty — and an empty table looks exactly like
  // a campaign nobody has imported yet.
  assert.equal(leadsKey('c_2'), 'leads:c_2');
});

test('a table that changed is recognised whichever campaign owns it', () => {
  assert.equal(isLeadsKey(leadsKey('c_9')), true);
  assert.equal(isLeadsKey('leads'), false, 'the pre-campaign key is gone and is not this');
  assert.equal(isLeadsKey('threads'), false);
});

test('the campaign is the one the outreach page is on', () => {
  assert.equal(activeCampaign(campaigns, 'c_2').name, 'Producers US');
});

test('a pointer at a deleted campaign falls back to the first, like the other half', () => {
  // storage.js answers the same way. Two answers to "which campaign" would put
  // these numbers on one lead table and the dashboard's on another.
  assert.equal(activeCampaign(campaigns, 'c_gone').id, 'c_1');
  assert.equal(activeCampaign(campaigns, null).id, 'c_1');
});

test('nothing imported yet is not a campaign', () => {
  assert.equal(activeCampaign([], 'c_1'), null);
  assert.equal(activeCampaign(undefined, undefined), null);
  assert.equal(activeCampaign([{ name: 'no id' }], null), null);
});
