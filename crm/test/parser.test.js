import test from 'node:test';
import assert from 'node:assert/strict';

import {
  snippetMarker,
  parseInboxBodies,
  threadListCursor,
  swapInboxCursor,
  swapThreadURL,
  pagingProbe,
  variableKeys,
  requestVariables,
  canPaginate,
  swapThreadVariables,
  parseConversation,
  classifyInboxBlock,
  parseThreadPage,
  threadIDFromURL,
  computeReplied,
} from '../lib/parser.js';

// Instagram's inbox payload, reduced to the shape the parser keys on: any object
// carrying `slide_messages` + a thread id, wherever it sits in the response.
function threadFixture(over = {}) {
  return {
    thread_id: 't1',
    last_activity_timestamp_ms: '1700000002000',
    viewer: { interop_messaging_user_fbid: '900' },
    viewer_id: '111',
    usersWithoutViewer: [
      { username: 'lead_one', full_name: 'Lead One', profile_pic_url: 'https://cdn/a.jpg', pk: 222 },
    ],
    slide_messages: {
      edges: [
        { node: { id: 'm1', sender_fbid: '900', timestamp_ms: '1700000001000', text_body: 'hey' } },
        { node: { id: 'm2', sender_fbid: '223', timestamp_ms: '1700000002000', text_body: 'hi back' } },
      ],
    },
    ...over,
  };
}

const wrap = (thread) => JSON.stringify({ data: { xdt_viewer: { inbox: { threads: [thread] } } } });

test('parses a thread out of a nested inbox payload', () => {
  const [t] = parseInboxBodies([wrap(threadFixture())]);
  assert.equal(t.threadID, 't1');
  assert.equal(t.username, 'lead_one');
  assert.equal(t.displayName, 'Lead One');
  assert.equal(t.avatarURL, 'https://cdn/a.jpg');
  assert.equal(t.lastActivityMs, 1700000002000);
  assert.equal(t.messages.length, 2);
});

test('direction comes from the viewer messaging fbid, not viewer_id', () => {
  // m1 was sent BY the operator: its sender_fbid matches interop_messaging_user_fbid
  // (900), while viewer_id is the IG pk (111). Comparing against viewer_id would
  // mark our own send as inbound and light the whole inbox up as unread.
  const [t] = parseInboxBodies([wrap(threadFixture())]);
  assert.equal(t.viewerID, '900');
  const m1 = t.messages.find((m) => m.id === 'm1');
  const m2 = t.messages.find((m) => m.id === 'm2');
  assert.equal(m1.senderFbid === t.viewerID, true, 'own send must resolve as outbound');
  assert.equal(m2.senderFbid === t.viewerID, false, "lead's reply must resolve as inbound");
});

test('falls back to viewer_id when the messaging fbid is absent', () => {
  const [t] = parseInboxBodies([wrap(threadFixture({ viewer: undefined }))]);
  assert.equal(t.viewerID, '111');
});

test('pk survives as a string whether IG sends a number or a string', () => {
  const asNumber = parseInboxBodies([wrap(threadFixture())])[0];
  const asString = parseInboxBodies([
    wrap(threadFixture({
      usersWithoutViewer: [{ username: 'lead_one', full_name: 'Lead One', pk: '222' }],
    })),
  ])[0];
  assert.equal(asNumber.igUserID, '222');
  assert.equal(asString.igUserID, '222');
});

test('identifies the lead from users[] when usersWithoutViewer is missing', () => {
  const [t] = parseInboxBodies([
    wrap(threadFixture({
      usersWithoutViewer: undefined,
      users: [
        { username: 'me', pk: '900' },
        { username: 'lead_two', full_name: 'Lead Two', profile_pic_url: 'https://cdn/b.jpg', pk: '333' },
      ],
    })),
  ]);
  assert.equal(t.username, 'lead_two');
  assert.equal(t.igUserID, '333');
});

test('message text falls back text_body → content.text_body → igd_snippet', () => {
  const [t] = parseInboxBodies([
    wrap(threadFixture({
      slide_messages: {
        edges: [
          { node: { id: 'a', sender_fbid: '223', timestamp_ms: 1, content: { text_body: 'from content' } } },
          { node: { id: 'b', sender_fbid: '223', timestamp_ms: 2, igd_snippet: 'ok sounds good' } },
          { node: { id: 'c', sender_fbid: '223', timestamp_ms: 3 } },
        ],
      },
    })),
  ]);
  assert.deepEqual(t.messages.map((m) => m.text), ['from content', 'ok sounds good', '']);
});

test("Instagram's preview line for a non-text message becomes a marker", () => {
  // These are UI copy ABOUT a message, not the message: rendered as-is they read
  // like an English sentence the operator typed.
  const [t] = parseInboxBodies([
    wrap(threadFixture({
      slide_messages: {
        edges: [
          { node: { id: 'a', sender_fbid: '900', timestamp_ms: 1, igd_snippet: 'You sent an attachment.' } },
          { node: { id: 'b', sender_fbid: '223', timestamp_ms: 2, igd_snippet: 'akku sent a photo.' } },
          { node: { id: 'c', sender_fbid: '900', timestamp_ms: 3, igd_snippet: 'You sent a video.' } },
          { node: { id: 'd', sender_fbid: '223', timestamp_ms: 4, igd_snippet: 'Soph sent a voice message.' } },
        ],
      },
    })),
  ]);
  assert.deepEqual(t.messages.map((m) => m.text), ['[media]', '[media]', '[media]', '[voice]']);
});

test('snippetMarker answers null for anything that is not one of those lines', () => {
  // The CRM runs already-stored message text through it, so a false positive
  // would relabel something a person actually wrote.
  assert.equal(snippetMarker('You sent an attachment.'), '[media]');
  assert.equal(snippetMarker('ok sounds good'), null);
  assert.equal(snippetMarker(''), null);
  assert.equal(snippetMarker(undefined), null);
});

test('a snippet that only looks like a preview is left alone', () => {
  // Someone writing about attachments is not an attachment.
  const [t] = parseInboxBodies([
    wrap(threadFixture({
      slide_messages: {
        edges: [
          { node: { id: 'a', sender_fbid: '223', timestamp_ms: 1, igd_snippet: 'i sent an attachment to your email' } },
          { node: { id: 'b', sender_fbid: '223', timestamp_ms: 2, text_body: 'You sent an attachment.' } },
        ],
      },
    })),
  ]);
  assert.deepEqual(t.messages.map((m) => m.text), ['i sent an attachment to your email', 'You sent an attachment.']);
});

test('reads a Relay stream: several JSON objects, one per line', () => {
  const body = [wrap(threadFixture()), wrap(threadFixture({ thread_id: 't2' }))].join('\n');
  const ids = parseInboxBodies([body]).map((t) => t.threadID).sort();
  assert.deepEqual(ids, ['t1', 't2']);
});

test('merges one thread arriving across two bodies without duplicating messages', () => {
  const first = wrap(threadFixture());
  const second = wrap(threadFixture({
    last_activity_timestamp_ms: '1700000009000',
    slide_messages: {
      edges: [
        { node: { id: 'm2', sender_fbid: '223', timestamp_ms: '1700000002000', text_body: 'hi back' } },
        { node: { id: 'm3', sender_fbid: '223', timestamp_ms: '1700000009000', text_body: 'still there?' } },
      ],
    },
  }));
  const parsed = parseInboxBodies([first, second]);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].messages.map((m) => m.id).sort(), ['m1', 'm2', 'm3']);
  assert.equal(parsed[0].lastActivityMs, 1700000009000);
});

test('garbage in returns an empty list instead of throwing', () => {
  assert.deepEqual(parseInboxBodies(['<!DOCTYPE html><html>login</html>']), []);
  assert.deepEqual(parseInboxBodies(['']), []);
  assert.deepEqual(parseInboxBodies([]), []);
});

test('skips thread-shaped objects that carry no thread id', () => {
  const body = JSON.stringify({ data: { slide_messages: { edges: [] } } });
  assert.deepEqual(parseInboxBodies([body]), []);
});

test('threadListCursor picks the thread connection, not the message edges', () => {
  const body = JSON.stringify({
    data: {
      messages: { edges: [{ node: { id: 'm1' } }], page_info: { end_cursor: 'WRONG', has_next_page: true } },
      threads: {
        edges: [{ node: { thread_id: 't1', as_ig_direct_thread: {} } }],
        page_info: { end_cursor: 'RIGHT', has_next_page: true },
      },
    },
  });
  assert.deepEqual(threadListCursor([body]), { end: 'RIGHT', hasNext: true });
});

test('threadListCursor prefers a connection that says there is a next page', () => {
  const body = JSON.stringify({
    a: { edges: [{ node: { thread_id: 't1' } }], page_info: { end_cursor: 'DONE', has_next_page: false } },
    b: { edges: [{ node: { thread_id: 't2' } }], page_info: { end_cursor: 'MORE', has_next_page: true } },
  });
  assert.deepEqual(threadListCursor([body]), { end: 'MORE', hasNext: true });
});

test('threadListCursor returns null when the payload has no thread connection', () => {
  assert.equal(threadListCursor([JSON.stringify({ data: {} })]), null);
});

test('swapInboxCursor replaces only variables.cursor and keeps every other field byte for byte', () => {
  const variables = encodeURIComponent(JSON.stringify({ cursor: 'OLD', limit: 20 }));
  const post = `av=123&fb_dtsg=TOKEN&doc_id=999&variables=${variables}`;
  const out = swapInboxCursor(post, 'NEW');
  const parts = Object.fromEntries(out.split('&').map((p) => p.split('=')));
  assert.equal(parts.av, '123');
  assert.equal(parts.fb_dtsg, 'TOKEN');
  assert.equal(parts.doc_id, '999');
  const vars = JSON.parse(decodeURIComponent(parts.variables));
  assert.equal(vars.cursor, 'NEW');
  assert.equal(vars.limit, 20, 'unrelated variables must survive the swap');
});

test('swapInboxCursor returns null when there is nothing to swap', () => {
  assert.equal(swapInboxCursor('av=123&doc_id=999', 'NEW'), null);
  assert.equal(swapInboxCursor('variables=not%20json', 'NEW'), null);
});

test('swapThreadURL retargets the conversation and leaves the rest of the query alone', () => {
  const url = 'https://www.instagram.com/api/v1/direct_v2/threads/111/?limit=20&visual_message_return_type=unseen';
  const out = new URL(swapThreadURL(url, '222'));
  assert.equal(out.pathname, '/api/v1/direct_v2/threads/222/');
  assert.equal(out.searchParams.get('limit'), '20');
  assert.equal(out.searchParams.get('visual_message_return_type'), 'unseen');
  assert.equal(out.searchParams.get('cursor'), null);
});

test('swapThreadURL carries a cursor for older messages, and drops the previous one', () => {
  const url = 'https://www.instagram.com/api/v1/direct_v2/threads/111/?limit=20&cursor=OLD';
  assert.equal(new URL(swapThreadURL(url, '111', 'NEXT')).searchParams.get('cursor'), 'NEXT');
  assert.equal(new URL(swapThreadURL(url, '111')).searchParams.get('cursor'), null);
});

test('swapThreadURL refuses a url that is not a thread request', () => {
  assert.equal(swapThreadURL('https://www.instagram.com/api/graphql', '222'), null);
  assert.equal(swapThreadURL('', '222'), null);
});

test('classifyInboxBlock reads rate limiting and challenges', () => {
  assert.equal(classifyInboxBlock(429, 'https://www.instagram.com/api/graphql', ''), 'rateLimited');
  assert.equal(classifyInboxBlock(401, 'https://www.instagram.com/api/graphql', ''), 'challenge');
  assert.equal(classifyInboxBlock(403, 'https://www.instagram.com/api/graphql', ''), 'challenge');
  assert.equal(classifyInboxBlock(200, 'https://www.instagram.com/challenge/?next=/', ''), 'challenge');
  assert.equal(classifyInboxBlock(200, 'https://www.instagram.com/accounts/login/', ''), 'challenge');
  assert.equal(
    classifyInboxBlock(200, 'https://www.instagram.com/api/graphql', JSON.stringify({ message: 'checkpoint_required' })),
    'challenge',
  );
});

test('a lead who types "challenge_required" never parks the account', () => {
  // The inbox payload embeds arbitrary text written by other people. Only a
  // TOP-LEVEL error object counts as a block; an unanchored scan would let any
  // lead disable the user's sync by sending them a message.
  const body = wrap(threadFixture({
    slide_messages: {
      edges: [{ node: { id: 'm9', sender_fbid: '223', timestamp_ms: 1, text_body: 'challenge_required lol' } }],
    },
  }));
  assert.equal(classifyInboxBlock(200, 'https://www.instagram.com/api/graphql', body), null);
});

test('classifyInboxBlock stays quiet on a healthy response', () => {
  assert.equal(classifyInboxBlock(200, 'https://www.instagram.com/api/graphql', '{"data":{}}'), null);
});

test('parseThreadPage reads history, converts microseconds and labels non-text items', () => {
  const page = parseThreadPage(JSON.stringify({
    thread: {
      viewer_id: '900',
      oldest_cursor: 'CURSOR',
      has_older: true,
      last_seen_at: { 900: { timestamp: '1700000500000000' }, 223: { timestamp: '1700000300000000' } },
      items: [
        { item_id: 'x1', user_id: 223, timestamp: '1700000100000000', item_type: 'text', text: 'hello' },
        { item_id: 'x2', user_id: 900, timestamp: '1700000200000000', item_type: 'media' },
        { item_id: 'x3', user_id: 900, timestamp: '1700000300000000', item_type: 'voice_media' },
        { item_id: 'x4', user_id: 223, timestamp: '1700000400000000', item_type: 'like' },
      ],
    },
  }));
  assert.equal(page.viewerID, '900');
  assert.equal(page.oldestCursor, 'CURSOR');
  assert.equal(page.hasOlder, true);
  assert.equal(page.messages[0].timestampMs, 1700000100000);
  assert.deepEqual(page.messages.map((m) => m.text), ['hello', '[media]', '[voice]', '❤']);
  assert.equal(page.leadLastSeenMs, 1700000300000, "the lead's last_seen_at, not the viewer's");
});

test('parseThreadPage reads the lead identity, picture included', () => {
  // The thread page is the OTHER place Instagram names the person, and the only
  // one that arrives when the linked tab opens a conversation. The inbox payload
  // does not always carry a profile picture; this one does, so a thread whose
  // list entry came back without one still ends up with a face.
  const page = parseThreadPage(JSON.stringify({
    thread: {
      viewer_id: '900',
      users: [{ pk: 223, username: 'drzybeats', full_name: 'DRZY', profile_pic_url: 'https://cdn/d.jpg' }],
      items: [{ item_id: 'x1', user_id: 223, timestamp: '1700000100000000', text: 'hi' }],
    },
  }));
  assert.deepEqual(page.lead, {
    igUserID: '223', username: 'drzybeats', displayName: 'DRZY', avatarURL: 'https://cdn/d.jpg',
  });
});

test('parseThreadPage never reads the operator as the lead', () => {
  // `users` usually excludes the viewer, but a thread that lists them would
  // otherwise put the operator's own face and handle on the lead's row.
  const page = parseThreadPage(JSON.stringify({
    thread: {
      viewer_id: '900',
      users: [
        { pk: 900, username: 'prayangelica', full_name: 'Me', profile_pic_url: 'https://cdn/me.jpg' },
        { pk: 223, username: 'drzybeats', full_name: 'DRZY', profile_pic_url: 'https://cdn/d.jpg' },
      ],
      items: [],
    },
  }));
  assert.equal(page.lead.username, 'drzybeats');
  assert.equal(page.lead.avatarURL, 'https://cdn/d.jpg');
});

test('a thread page that names nobody reports no lead rather than a blank one', () => {
  // A row is only ever updated from a lead that HAS something in it: writing
  // empty strings over a name Instagram gave us earlier would erase it.
  const page = parseThreadPage(JSON.stringify({ thread: { viewer_id: '900', items: [] } }));
  assert.equal(page.lead, null);
});

test('parseThreadPage learns the operator own username, but only from their own thread', () => {
  // Nothing else Instagram sends us names the logged-in account: the inbox
  // payload identifies it by number only. `inviter` is a name — and it is ours
  // exactly when the inviter's pk IS the viewer, i.e. we started the thread.
  const page = (inviter) => parseThreadPage(JSON.stringify({
    thread: { viewer_id: '900', inviter, items: [] },
  }));
  assert.equal(page({ pk: 900, username: 'prayangelica' }).viewerUsername, 'prayangelica');
  assert.equal(page({ pk: '223', username: 'lead_one' }).viewerUsername, '', 'the lead invited us — not our name');
  assert.equal(page(undefined).viewerUsername, '');
});

test('threadIDFromURL pulls the id out of the history request', () => {
  assert.equal(
    threadIDFromURL('https://www.instagram.com/api/v1/direct_v2/threads/3402823668417103/?limit=20'),
    '3402823668417103',
  );
  assert.equal(threadIDFromURL('https://www.instagram.com/api/v1/direct_v2/inbox/'), '');
  assert.equal(threadIDFromURL(undefined), '');
});

test('parseThreadPage survives a body that is not a thread', () => {
  assert.equal(parseThreadPage('nope'), null);
  assert.equal(parseThreadPage('{}')?.messages.length, 0);
});

test('computeReplied is true only when the lead answers after we wrote first', () => {
  const out = (t) => ({ direction: 'out', timestamp: t });
  const inb = (t) => ({ direction: 'in', timestamp: t });
  assert.equal(computeReplied([out(1), inb(2)]), true);
  assert.equal(computeReplied([inb(1), out(2)]), false, 'they messaged us first — that is not a reply to outreach');
  assert.equal(computeReplied([out(1)]), false);
  assert.equal(computeReplied([]), false);
  assert.equal(computeReplied([inb(1), out(2), inb(3)]), true);
});

// ── the cursor, in whichever dialect Instagram wrote it ────────────────────

test('threadListCursor reads the live mailbox shape: threads under edges, no page_info', () => {
  // As captured from real traffic (outreach/test/conversations.test.mjs): the
  // mailbox nests the connection, and the paging sits on the object above it.
  const body = JSON.stringify({
    data: {
      get_slide_mailbox_for_iris_subscription: {
        __typename: 'SlideMailbox',
        has_older: true,
        oldest_cursor: 'DEEP',
        threads_by_folder: {
          edges: [{ node: { as_ig_direct_thread: { thread_id: '1', thread_key: '1' } } }],
        },
      },
    },
  });
  assert.deepEqual(threadListCursor([body]), { end: 'DEEP', hasNext: true });
});

test('threadListCursor reads the older private-api shape too', () => {
  const body = JSON.stringify({ inbox: { threads: [{ thread_id: '1' }], oldest_cursor: 'OLD', has_older: true } });
  assert.deepEqual(threadListCursor([body]), { end: 'OLD', hasNext: true });
});

test('threadListCursor still ignores the paging of a MESSAGE list', () => {
  // The messages inside one conversation page too, and taking that cursor would
  // walk one thread's history while believing it is walking the inbox.
  const body = JSON.stringify({
    thread: {
      oldest_cursor: 'MESSAGES',
      has_older: true,
      messages: { edges: [{ node: { id: 'm1' } }], page_info: { end_cursor: 'ALSO_MESSAGES', has_next_page: true } },
    },
  });
  assert.equal(threadListCursor([body]), null);
});

test('pagingProbe says where the paging is, and never what it says', () => {
  const body = JSON.stringify({
    data: {
      inbox: {
        threads_by_folder: { edges: [{ node: { thread_id: '1' } }], page_info: { end_cursor: 'SECRETTOKEN', has_next_page: false } },
        oldest_cursor: 'ANOTHERSECRET',
      },
    },
  });
  const probe = pagingProbe(body);
  const joined = probe.join(' ');
  assert.ok(!joined.includes('SECRETTOKEN'), 'a cursor value must not travel out in the probe');
  assert.ok(!joined.includes('ANOTHERSECRET'));
  assert.ok(probe.some((p) => p.includes('page_info{end_cursor,has_next_page}')), joined);
  assert.ok(probe.some((p) => p === 'data.inbox.oldest_cursor=string'), joined);
  assert.ok(probe.some((p) => p.includes('has_next_page=false')), joined);
});

test('pagingProbe points at the list that would be paged', () => {
  const body = JSON.stringify({ data: { inbox: { threads_by_folder: [{ thread_id: '1' }, { thread_id: '2' }] } } });
  assert.ok(pagingProbe(body).includes('data.inbox.threads_by_folder[2]'));
});

test('variableKeys names the variables and never their values', () => {
  const post = `av=123&fb_dtsg=TOKEN&doc_id=999&variables=${encodeURIComponent(JSON.stringify({ threadID: '340', cursor: 'DEEP', limit: 20 }))}`;
  const keys = variableKeys(post);
  assert.deepEqual(keys.sort(), ['cursor', 'limit', 'threadID']);
  assert.ok(!JSON.stringify(keys).includes('DEEP'));
  assert.ok(!JSON.stringify(keys).includes('TOKEN'));
});

test('variableKeys answers empty for a request with nothing to name', () => {
  assert.deepEqual(variableKeys('av=123&doc_id=999'), []);
  assert.deepEqual(variableKeys('variables=not%20json'), []);
  assert.deepEqual(variableKeys(undefined), []);
});

test('swapThreadVariables retargets the conversation query and clears the page marker', () => {
  const variables = encodeURIComponent(JSON.stringify({ thread_fbid: '111', min_uq_seq_id: '9', count: 20 }));
  const out = swapThreadVariables(`av=1&doc_id=555&variables=${variables}`, '222');
  const vars = JSON.parse(decodeURIComponent(out.split('variables=')[1]));
  assert.equal(vars.thread_fbid, '222');
  assert.equal(vars.min_uq_seq_id, null, 'one conversation’s sequence number means nothing in another');
  assert.equal(vars.count, 20, 'unrelated variables must survive');
  assert.ok(out.startsWith('av=1&doc_id=555&'));
});

test('swapThreadVariables carries a page marker when asked for older messages', () => {
  const variables = encodeURIComponent(JSON.stringify({ thread_fbid: '111', min_uq_seq_id: null }));
  const out = swapThreadVariables(`variables=${variables}`, '111', 'SEQ42');
  assert.equal(JSON.parse(decodeURIComponent(out.split('variables=')[1])).min_uq_seq_id, 'SEQ42');
});

test('swapThreadVariables refuses a request that names no conversation', () => {
  // The inbox query has no thread_fbid. Retargeting it would send something
  // nobody asked for and read the answer as a conversation.
  const inbox = `variables=${encodeURIComponent(JSON.stringify({ cursor: null, count: 20 }))}`;
  assert.equal(swapThreadVariables(inbox, '222'), null);
  assert.equal(swapThreadVariables('av=1&doc_id=555', '222'), null);
});

test('parseConversation reads the GraphQL dialect, paging and all', () => {
  const body = JSON.stringify({
    data: {
      get_slide_thread_nullable: {
        as_ig_direct_thread: {
          thread_id: '111',
          viewer: { interop_messaging_user_fbid: '900' },
          usersWithoutViewer: [{ username: 'lead_one', pk: '222' }],
          slide_messages: {
            edges: [{ node: { id: 'm1', sender_fbid: '900', timestamp_ms: '1700000001000', text_body: 'hey' } }],
            page_info: { end_cursor: 'OLDER', has_next_page: true },
          },
        },
      },
    },
  });
  const parsed = parseConversation(body);
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.viewerID, '900');
  assert.equal(parsed.hasOlder, true);
  assert.equal(parsed.oldestCursor, 'OLDER');
  assert.equal(parsed.lead.username, 'lead_one');
});

test('parseConversation still reads the old REST dialect', () => {
  const body = JSON.stringify({
    thread: { viewer_id: '55501', items: [{ item_id: 'i1', user_id: '55501', timestamp: 1700000001000000, text: 'hey' }], has_older: true, oldest_cursor: 'C1' },
  });
  const parsed = parseConversation(body);
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.oldestCursor, 'C1');
  assert.equal(parsed.hasOlder, true);
});

test('swapInboxCursor refuses a query that has no cursor variable', () => {
  // Adding one produces a request that looks right and is answered with the
  // same page every time: a walk that never moves and never fails.
  const noCursor = `variables=${encodeURIComponent(JSON.stringify({ device_id_for_iris_subscription: 'x' }))}`;
  assert.equal(swapInboxCursor(noCursor, 'NEXT'), null);
  assert.equal(canPaginate(noCursor), false);
});

test('canPaginate recognises the query that can walk the list', () => {
  const withCursor = `variables=${encodeURIComponent(JSON.stringify({ count: 20, cursor: null, id: '1' }))}`;
  assert.equal(canPaginate(withCursor), true);
  assert.equal(requestVariables(withCursor).count, 20);
  assert.ok(swapInboxCursor(withCursor, 'NEXT').includes('NEXT'));
});
