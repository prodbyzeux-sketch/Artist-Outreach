import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyMessage } from '../page/queue.js';

test('an empty folder says so, and the way out is leaving it', () => {
  const message = emptyMessage({ filtering: false, folder: 'f1', campaignOnly: false });
  assert.match(message.title, /folder/i);
  assert.equal(message.action, 'clear');
});

test('a filter that matches nobody outranks the folder it was typed in', () => {
  // Otherwise searching inside a folder reports the folder as empty, which is a
  // different problem with a different way out.
  const message = emptyMessage({ filtering: true, folder: 'f1', campaignOnly: false });
  assert.equal(message.title, 'Nothing found');
  assert.equal(message.action, 'clear');
});

test('a campaign whose leads are not in this inbox is its own dead end', () => {
  const message = emptyMessage({ filtering: false, folder: '', campaignOnly: true });
  assert.match(message.title, /campaign/i);
  assert.equal(message.action, 'all', 'the way out is the whole inbox, not a filter nobody set');
});

test('a filter beats a campaign too', () => {
  assert.equal(emptyMessage({ filtering: true, folder: '', campaignOnly: true }).action, 'clear');
});

test('every one of them has words and a button', () => {
  for (const args of [
    { filtering: true }, { folder: 'f1' }, { campaignOnly: true }, {},
  ]) {
    const message = emptyMessage(args);
    assert.ok(message.title && message.hint && message.label, JSON.stringify(args));
  }
});
