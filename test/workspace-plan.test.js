import test from 'node:test';
import assert from 'node:assert/strict';

import { planWorkspace } from '../lib/workspace-plan.js';

const WANTED = [
  { key: 'outreach', url: 'chrome-extension://ext/outreach/src/app.html' },
  { key: 'crm', url: 'chrome-extension://ext/crm/page/crm.html' },
  { key: 'instagram', url: 'https://www.instagram.com/direct/inbox/', prefix: 'https://www.instagram.com/' },
];

const plan = (over = {}) => planWorkspace({
  wanted: WANTED,
  tabs: [],
  groups: [],
  currentWindowId: 1,
  groupTitle: 'Artist Outreach',
  ...over,
});

test('nothing open yet: everything is created in the current window, in a new group', () => {
  const result = plan();
  assert.deepEqual(result.create.map((c) => c.key), ['outreach', 'crm', 'instagram']);
  assert.deepEqual(result.reuse, []);
  assert.equal(result.windowId, 1);
  assert.equal(result.groupId, null);
});

test('an open tab is reused, not duplicated', () => {
  const result = plan({
    tabs: [{ id: 7, url: 'chrome-extension://ext/crm/page/crm.html', windowId: 1, pinned: false, groupId: -1 }],
  });
  assert.deepEqual(result.reuse.map((r) => [r.key, r.tabId]), [['crm', 7]]);
  assert.deepEqual(result.create.map((c) => c.key), ['outreach', 'instagram']);
});

test('any Instagram tab counts as the Instagram tab', () => {
  const result = plan({
    tabs: [{ id: 3, url: 'https://www.instagram.com/direct/t/340282/', windowId: 1, pinned: false, groupId: -1 }],
  });
  assert.deepEqual(result.reuse.map((r) => r.key), ['instagram']);
  assert.equal(result.reuse[0].tabId, 3);
});

test('the group lands in the window that already holds one of the tabs', () => {
  const result = plan({
    currentWindowId: 1,
    tabs: [{ id: 7, url: 'chrome-extension://ext/crm/page/crm.html', windowId: 9, pinned: false, groupId: -1 }],
  });
  assert.equal(result.windowId, 9);
  assert.equal(result.reuse[0].needsMove, false, 'it is already where the group will be');
});

test('a tab in another window is moved to the group instead of being left behind', () => {
  const result = plan({
    tabs: [
      { id: 7, url: 'chrome-extension://ext/outreach/src/app.html', windowId: 9, pinned: false, groupId: -1 },
      { id: 8, url: 'https://www.instagram.com/', windowId: 4, pinned: false, groupId: -1 },
    ],
  });
  assert.equal(result.windowId, 9, 'the first wanted tab decides the window');
  assert.equal(result.reuse.find((r) => r.key === 'instagram').needsMove, true);
});

test('a pinned tab is unpinned — Chrome refuses to group pinned tabs', () => {
  const result = plan({
    tabs: [{ id: 3, url: 'https://www.instagram.com/direct/inbox/', windowId: 1, pinned: true, groupId: -1 }],
  });
  assert.equal(result.reuse[0].needsUnpin, true);
});

test('an existing group with our title is joined, not replaced', () => {
  const result = plan({
    tabs: [{ id: 7, url: 'chrome-extension://ext/crm/page/crm.html', windowId: 1, pinned: false, groupId: 42 }],
    groups: [{ id: 42, title: 'Artist Outreach', windowId: 1 }],
  });
  assert.equal(result.groupId, 42);
});

test("someone else's group in the same window is left alone", () => {
  const result = plan({
    tabs: [{ id: 7, url: 'chrome-extension://ext/crm/page/crm.html', windowId: 1, pinned: false, groupId: 42 }],
    groups: [{ id: 42, title: 'работа', windowId: 1 }],
  });
  assert.equal(result.groupId, null, 'a new group is made rather than renaming the one the user built');
});

test('our group in another window does not pull the workspace over', () => {
  const result = plan({
    tabs: [{ id: 7, url: 'chrome-extension://ext/crm/page/crm.html', windowId: 1, pinned: false, groupId: -1 }],
    groups: [{ id: 42, title: 'Artist Outreach', windowId: 5 }],
  });
  assert.equal(result.windowId, 1);
  assert.equal(result.groupId, null);
});

test('duplicates of the same page are ignored, not gathered', () => {
  const result = plan({
    tabs: [
      { id: 7, url: 'chrome-extension://ext/crm/page/crm.html', windowId: 1, pinned: false, groupId: -1 },
      { id: 8, url: 'chrome-extension://ext/crm/page/crm.html', windowId: 1, pinned: false, groupId: -1 },
    ],
  });
  assert.deepEqual(result.reuse.map((r) => r.tabId), [7]);
});

test('the window a send run is driving is never taken into the workspace', () => {
  // The outreach half owns that window through chrome.debugger; moving its tab
  // into a group — or steering it to a thread — breaks the run in flight.
  const result = plan({
    busy: { windowId: 9, tabId: 3 },
    tabs: [
      { id: 3, url: 'https://www.instagram.com/direct/t/1/', windowId: 9, pinned: false, groupId: -1 },
      { id: 4, url: 'https://www.instagram.com/', windowId: 1, pinned: false, groupId: -1 },
    ],
  });
  assert.deepEqual(result.reuse.map((r) => r.tabId), [4], 'the free tab is used, the driven one is left alone');
});

test('with a run going and no other Instagram tab, a fresh one is opened', () => {
  const result = plan({
    busy: { windowId: 9, tabId: 3 },
    tabs: [{ id: 3, url: 'https://www.instagram.com/direct/t/1/', windowId: 9, pinned: false, groupId: -1 }],
  });
  assert.deepEqual(result.create.map((c) => c.key), ['outreach', 'crm', 'instagram']);
});

test('the page to focus is named, and it is the one the click is about', () => {
  assert.equal(plan().activate, 'outreach');
  assert.equal(plan({ activate: 'crm' }).activate, 'crm');
});
