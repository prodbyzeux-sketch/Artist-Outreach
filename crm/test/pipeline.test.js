import test from 'node:test';
import assert from 'node:assert/strict';

import { parseInboxBodies } from '../lib/parser.js';
import { createStore } from '../lib/store.js';

// The unit tests either side of this seam use hand-written objects, so a field
// renamed on one side would pass both suites and still ship a broken extension.
// This walks the real path: raw Instagram body → parser → store → what the UI reads.

function memoryArea() {
  const data = {};
  return {
    async get(keys) {
      const out = {};
      for (const k of [].concat(keys ?? Object.keys(data))) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(items) { for (const [k, v] of Object.entries(items)) data[k] = structuredClone(v); },
  };
}

const VIEWER_FBID = '17841400000000000';

const inboxBody = JSON.stringify({
  data: {
    xdt_viewer: {
      inbox: {
        threads_by_folder: [
          {
            thread_id: '340282366841710300949128000000000001',
            last_activity_timestamp_ms: '1754500000000',
            viewer: { interop_messaging_user_fbid: VIEWER_FBID },
            viewer_id: '55501',
            usersWithoutViewer: [
              { username: 'mila.beats', full_name: 'Мила Ковалёва', profile_pic_url: 'https://cdn/mila.jpg', pk: 778899 },
            ],
            slide_messages: {
              edges: [
                { node: { id: 'mid_out_1', sender_fbid: VIEWER_FBID, timestamp_ms: '1754499000000', text_body: 'привет! нужен микс?' } },
                { node: { id: 'mid_in_1', sender_fbid: '990011', timestamp_ms: '1754500000000', text_body: 'да, скинь прайс' } },
              ],
            },
          },
        ],
      },
    },
  },
});

test('a raw inbox body becomes a conversation row the UI can render', async () => {
  const store = createStore(memoryArea());
  const threads = parseInboxBodies([inboxBody]);
  assert.equal(threads.length, 1);

  const viewerFbid = threads[0].viewerID;
  assert.equal(viewerFbid, VIEWER_FBID, 'the messaging fbid is what direction is judged against');

  const result = await store.ingest(threads, viewerFbid);
  assert.equal(result.added, 1);
  assert.equal(result.newInbound, 1, 'their reply is unacknowledged');

  const [row] = await store.listThreads(viewerFbid);
  assert.equal(row.username, 'mila.beats');
  assert.equal(row.displayName, 'Мила Ковалёва');
  assert.equal(row.igUserID, '778899', 'a numeric pk survives as a string');
  assert.equal(row.lastMessage, 'да, скинь прайс');
  assert.equal(row.lastActivityAt, 1754500000000);
  assert.equal(row.replied, true);
  assert.equal(row.needsAttention, true);

  const messages = await store.messages(viewerFbid, row.threadID);
  assert.deepEqual(messages.map((m) => m.direction), ['out', 'in'], 'our own message must not read as inbound');
});

test('the same body ingested twice adds nothing', async () => {
  const store = createStore(memoryArea());
  const threads = () => parseInboxBodies([inboxBody]);
  await store.ingest(threads(), VIEWER_FBID);
  const second = await store.ingest(threads(), VIEWER_FBID);
  assert.deepEqual(second, { added: 0, updated: 0, newInbound: 0 });
});
