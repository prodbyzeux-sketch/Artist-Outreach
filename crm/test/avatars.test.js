import test from 'node:test';
import assert from 'node:assert/strict';

import { pictureID, staleAvatars, FETCH_BATCH, RETRY_AFTER_MS } from '../lib/avatars.js';

const NOW = Date.UTC(2026, 7, 8, 12, 0, 0);
const HOUR = 3600000;

// A real one, shortened: the path names the picture, the query signs it.
const cdn = (name, sig) =>
  `https://scontent-arn2-1.cdninstagram.com/v/t51.2885-19/${name}.jpg?stp=dst-jpg_e0_s150x150&_nc_ht=scontent-arn2-1.cdninstagram.com&oe=${sig}`;

const row = (over = {}) => ({
  threadID: 't1', igUserID: '111', avatarURL: cdn('458_1_2_n', '68A1B2C3'), lastActivityAt: NOW, ...over,
});

test('a picture is identified by its path, not by its signature', () => {
  // The whole point: Instagram re-signs the same image constantly, and it serves
  // it from whichever edge is closest. Comparing whole urls would refetch every
  // avatar on every capture and still never notice a real change.
  assert.equal(pictureID(cdn('458_1_2_n', '68A1B2C3')), '458_1_2_n');
  assert.equal(pictureID(cdn('458_1_2_n', 'FFFFFFFF')), '458_1_2_n');
  assert.equal(
    pictureID('https://scontent-hel3-1.cdninstagram.com/v/t51.2885-19/458_1_2_n.jpg?oe=1'),
    '458_1_2_n',
    'a different CDN edge is the same picture',
  );
  assert.notEqual(pictureID(cdn('999_9_9_n', '68A1B2C3')), pictureID(cdn('458_1_2_n', '68A1B2C3')));
});

test('anything that is not a usable picture url has no id', () => {
  for (const bad of ['', null, undefined, 'not a url', 'https://cdn/', 'data:image/png;base64,AAA', 42]) {
    assert.equal(pictureID(bad), '', `${String(bad)} should have no id`);
  }
});

test('a lead with no cached picture is fetched', () => {
  const [first] = staleAvatars([row()], {}, { now: NOW });
  assert.deepEqual(first, { igUserID: '111', id: '458_1_2_n', url: row().avatarURL });
});

test('a lead whose picture is already kept is left alone', () => {
  const cached = { 111: { id: '458_1_2_n', data: 'data:image/jpeg;base64,AAA' } };
  assert.deepEqual(staleAvatars([row()], cached, { now: NOW }), []);
  // The same picture, freshly signed, is still the same picture.
  assert.deepEqual(staleAvatars([row({ avatarURL: cdn('458_1_2_n', 'DEADBEEF') })], cached, { now: NOW }), []);
});

test('a lead who changed their picture is fetched again', () => {
  const cached = { 111: { id: '458_1_2_n', data: 'data:image/jpeg;base64,AAA' } };
  const out = staleAvatars([row({ avatarURL: cdn('999_9_9_n', '1') })], cached, { now: NOW });
  assert.deepEqual(out.map((a) => a.id), ['999_9_9_n']);
});

test('a picture that failed is not retried on the next capture, but is retried later', () => {
  // Instagram serves the inbox constantly; without this a dead url is refetched
  // every few seconds forever. With a cooldown, an expired signature still gets
  // another go once a fresh one has had time to arrive.
  const cached = { 111: { id: '458_1_2_n', failedAt: NOW - HOUR } };
  assert.deepEqual(staleAvatars([row()], cached, { now: NOW }), []);
  assert.equal(staleAvatars([row()], cached, { now: NOW + RETRY_AFTER_MS }).length, 1);
});

test('rows with nothing to fetch are skipped rather than queued', () => {
  const rows = [
    row({ igUserID: '', threadID: 'no-user' }),
    row({ avatarURL: '', threadID: 'no-url' }),
    row({ avatarURL: 'javascript:alert(1)', threadID: 'not-a-picture' }),
  ];
  assert.deepEqual(staleAvatars(rows, {}, { now: NOW }), []);
});

test('the newest conversations are fetched first, and the batch is capped', () => {
  // A first capture can bring back hundreds of threads. Opening that many
  // requests at once is what a rate limiter is for, and the rows the operator is
  // actually looking at are the ones at the top of the list.
  const many = Array.from({ length: FETCH_BATCH + 8 }, (_, i) =>
    row({ threadID: `t${i}`, igUserID: String(i), avatarURL: cdn(`pic${i}`, '1'), lastActivityAt: NOW - i * HOUR }));
  const out = staleAvatars(many.slice().reverse(), {}, { now: NOW });
  assert.equal(out.length, FETCH_BATCH);
  assert.deepEqual(out.map((a) => a.id).slice(0, 3), ['pic0', 'pic1', 'pic2']);
});

test('one person in two conversations is fetched once', () => {
  const out = staleAvatars([row({ threadID: 'a' }), row({ threadID: 'b' })], {}, { now: NOW });
  assert.equal(out.length, 1);
});
