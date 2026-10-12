import test from 'node:test';
import assert from 'node:assert/strict';

import { allowsOrigin, normalizeCommand, NOTE_LIMIT } from '../lib/intake.js';

// ── who may talk to the daemon ─────────────────────────────────────────────

test('a tool on this machine has no Origin and is let in', () => {
  // curl, a script, Claude Code. Browsers always send one; nothing else does.
  assert.equal(allowsOrigin(undefined), true);
  assert.equal(allowsOrigin(''), true);
});

test('the extension is let in', () => {
  assert.equal(allowsOrigin('chrome-extension://abcdefghijklmnop'), true);
});

test('a web page is refused, whatever it claims to be', () => {
  // The socket is on loopback, which keeps the network out but not the browser:
  // any open tab can fetch 127.0.0.1. Origin is the only thing a page cannot lie
  // about, so it is what the door checks.
  assert.equal(allowsOrigin('https://evil.example'), false);
  assert.equal(allowsOrigin('http://localhost:3000'), false);
  assert.equal(allowsOrigin('https://www.instagram.com'), false);
  assert.equal(allowsOrigin('null'), false);
});

test('a near-miss on the extension scheme is refused', () => {
  assert.equal(allowsOrigin('https://chrome-extension.evil.example'), false);
  assert.equal(allowsOrigin('chrome-extension-evil://x'), false);
});

// ── what a command must be ────────────────────────────────────────────────

const BATCH = { account: 'prayangelica' };
const ok = (input, batch = BATCH) => {
  const { command, error } = normalizeCommand(input, batch);
  assert.equal(error, null, `expected acceptance, got: ${error}`);
  return command;
};
const refused = (input, batch = BATCH) => {
  const { command, error } = normalizeCommand(input, batch);
  assert.equal(command, null, 'expected refusal');
  return error;
};

test('a patch carries its thread, its target and a fresh id', () => {
  const command = ok({ type: 'patch', threadID: ' 340 ', fields: { stage: 'pitched' } });
  assert.equal(command.threadID, '340');
  assert.equal(command.account, 'prayangelica');
  assert.equal(command.type, 'patch');
  assert.match(command.id, /^c_/);
});

test('a command with no thread or no target is refused at the door', () => {
  assert.match(refused({ type: 'patch', fields: { stage: 'won' } }), /thread/i);
  assert.match(refused({ type: 'patch', threadID: '340', fields: { stage: 'won' } }, {}), /account|source/i);
});

test('an unknown type is refused rather than queued forever', () => {
  assert.match(refused({ type: 'send', threadID: '340', text: 'hi' }), /type/i);
});

test('a stage outside the funnel is refused, not silently mapped to new', () => {
  // The store forces an unknown stage to `new` on read, so a typo would look
  // like it worked and quietly reset the lead's real stage.
  assert.match(refused({ type: 'patch', threadID: '340', fields: { stage: 'closed' } }), /stage/i);
  assert.match(refused({ type: 'patch', threadID: '340', fields: { stage: 42 } }), /stage/i);
  assert.equal(ok({ type: 'patch', threadID: '340', fields: { stage: 'won' } }).fields.stage, 'won');
});

test('tags that are not a list of strings are refused', () => {
  // `tags: 42` reaches storage, and every later render of the list throws on it:
  // the CRM stays broken across reloads until storage is edited by hand.
  assert.match(refused({ type: 'patch', threadID: '340', fields: { tags: 42 } }), /tags/i);
  assert.match(refused({ type: 'patch', threadID: '340', fields: { tags: 'warm' } }), /tags/i);
  assert.match(refused({ type: 'patch', threadID: '340', fields: { tags: [1, 2] } }), /tags/i);
});

test('accepted tags come out cleaned and deduped, as if typed', () => {
  const command = ok({ type: 'patch', threadID: '340', fields: { tags: ['#warm ', 'WARM', ' ru '] } });
  assert.deepEqual(command.fields.tags, ['warm', 'ru']);
});

test('a note must be text, and an absurd one is refused rather than truncated', () => {
  assert.match(refused({ type: 'patch', threadID: '340', fields: { note: { a: 1 } } }), /note/i);
  assert.match(refused({ type: 'patch', threadID: '340', fields: { note: 'x'.repeat(NOTE_LIMIT + 1) } }), /note/i);
  assert.equal(ok({ type: 'patch', threadID: '340', fields: { note: ' call thursday ' } }).fields.note, ' call thursday ');
});

test('a follow-up is a millisecond timestamp, or nothing at all', () => {
  const at = Date.UTC(2026, 7, 12, 21, 59);
  assert.equal(ok({ type: 'patch', threadID: '340', fields: { followUpAt: at } }).fields.followUpAt, at);
  assert.equal(ok({ type: 'patch', threadID: '340', fields: { followUpAt: null } }).fields.followUpAt, null);
  // Seconds are the mistake worth catching: 1786203456 ms is 1970, and a
  // follow-up in 1970 is due forever without ever looking wrong.
  assert.match(refused({ type: 'patch', threadID: '340', fields: { followUpAt: 1786203456 } }), /seconds/i);
  assert.match(refused({ type: 'patch', threadID: '340', fields: { followUpAt: '2026-08-12' } }), /followUpAt/i);
  assert.match(refused({ type: 'patch', threadID: '340', fields: { followUpAt: at + 0.5 } }), /followUpAt/i);
});

test('a patch that touches none of the operator columns is refused', () => {
  // It would apply cleanly, change nothing and be acked — the sender would never
  // learn that `username` is not theirs to write.
  assert.match(refused({ type: 'patch', threadID: '340', fields: {} }), /stage|note|tags/i);
  assert.match(refused({ type: 'patch', threadID: '340', fields: { username: 'someone' } }), /stage|note|tags/i);
  assert.match(refused({ type: 'patch', threadID: '340', fields: [] }), /fields/i);
});

test('only the operator columns survive, even alongside valid ones', () => {
  const command = ok({ type: 'patch', threadID: '340', fields: { stage: 'won', username: 'someone' } });
  assert.deepEqual(command.fields, { stage: 'won' });
});

test('a draft needs text that is actually text', () => {
  assert.equal(ok({ type: 'draft', threadID: '340', text: 'hey' }).text, 'hey');
  assert.match(refused({ type: 'draft', threadID: '340', text: '   ' }), /text/i);
  assert.match(refused({ type: 'draft', threadID: '340', text: 42 }), /text/i);
});

test('a command names its own target, overriding the batch', () => {
  const command = ok({ type: 'draft', threadID: '340', text: 'hey', account: 'praypolina' });
  assert.equal(command.account, 'praypolina');
});

// ── backfill: the one command that is about the account, not a thread ──────

test('a backfill names its target and no thread — there is no thread to name', () => {
  const command = ok({ type: 'backfill' });
  assert.equal(command.type, 'backfill');
  assert.equal(command.account, 'prayangelica');
  assert.equal(command.threadID, '');
  assert.match(command.id, /^c_/);
});

test('a backfill still has to be addressed to somebody', () => {
  // Unaddressed it would be handed to nobody and sit in the queue forever —
  // and if it were broadcast, the wrong account would start walking its inbox.
  assert.match(refused({ type: 'backfill' }, {}), /account|source/i);
});

test('a backfill addressed by source alone is accepted', () => {
  const command = ok({ type: 'backfill', source: 's-1234' }, {});
  assert.equal(command.source, 's-1234');
  assert.equal(command.account, '');
});
