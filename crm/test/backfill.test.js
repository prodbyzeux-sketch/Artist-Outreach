import test from 'node:test';
import assert from 'node:assert/strict';

import { walkInbox, walkThread, scrollInbox } from '../lib/backfill.js';

const TEMPLATE = {
  url: 'https://www.instagram.com/api/graphql',
  headers: { 'x-ig-app-id': '936619743392459' },
  body: `av=17841400000000000&doc_id=999&variables=${encodeURIComponent(JSON.stringify({ cursor: 'FIRST', limit: 20 }))}`,
};

/** One inbox page: `n` threads and the cursor Instagram would hand back. */
function page(threadIDs, { end, hasNext }) {
  return JSON.stringify({
    data: {
      inbox: {
        threads: {
          edges: threadIDs.map((id) => ({ node: { thread_id: id } })),
          page_info: { end_cursor: end, has_next_page: hasNext },
        },
      },
    },
  });
}

const cursorOf = (template) => JSON.parse(decodeURIComponent(template.body.split('variables=')[1])).cursor;

/** A replay that answers from a script of pages, recording what it was asked. */
function fakeReplay(pages) {
  const asked = [];
  const replay = async (template) => {
    asked.push(template);
    const next = pages[asked.length - 1];
    if (!next) throw new Error(`replay called ${asked.length} times, script has ${pages.length}`);
    return next;
  };
  return { replay, asked };
}

/** Ingest that counts what it was handed and never claims a change it didn't make. */
function fakeIngest() {
  const bodies = [];
  const ingest = async (body) => {
    bodies.push(body);
    const threads = JSON.parse(body).data.inbox.threads.edges.length;
    return { threads, added: threads, updated: 0, newInbound: 0 };
  };
  return { ingest, bodies };
}

const never = async () => { throw new Error('should not have been called'); };
const noSleep = async () => {};

test('walks page after page until Instagram says there is no next one', async () => {
  const { replay, asked } = fakeReplay([
    { status: 200, url: TEMPLATE.url, body: page(['t2'], { end: 'C2', hasNext: true }) },
    { status: 200, url: TEMPLATE.url, body: page(['t3'], { end: 'C3', hasNext: true }) },
    { status: 200, url: TEMPLATE.url, body: page(['t4'], { end: null, hasNext: false }) },
  ]);
  const { ingest, bodies } = fakeIngest();

  const result = await walkInbox({ pageTemplate: TEMPLATE, cursor: 'C1', replay, ingest, sleep: noSleep });

  assert.equal(result.stopped, 'exhausted');
  assert.equal(result.pages, 3);
  assert.equal(result.added, 3);
  assert.equal(result.hasMore, false);
  assert.equal(bodies.length, 3);
  // Every request carries the cursor the PREVIOUS page handed back, and nothing else moves.
  assert.deepEqual(asked.map(cursorOf), ['C1', 'C2', 'C3']);
  for (const t of asked) {
    assert.equal(t.url, TEMPLATE.url);
    assert.deepEqual(t.headers, TEMPLATE.headers);
    assert.equal(t.body.split('&').filter((p) => !p.startsWith('variables=')).join('&'), 'av=17841400000000000&doc_id=999');
  }
});

test('a rate limit stops the walk where it stands instead of hammering', async () => {
  const { replay, asked } = fakeReplay([
    { status: 200, url: TEMPLATE.url, body: page(['t2'], { end: 'C2', hasNext: true }) },
    { status: 429, url: TEMPLATE.url, body: '' },
  ]);
  const { ingest } = fakeIngest();

  const result = await walkInbox({ pageTemplate: TEMPLATE, cursor: 'C1', replay, ingest, sleep: noSleep });

  assert.equal(result.stopped, 'block:rateLimited');
  assert.equal(result.pages, 1);
  assert.equal(asked.length, 2);
  // The cursor of the page that was NOT read is what a resumed walk must ask for.
  assert.equal(result.cursor, 'C2');
  assert.equal(result.hasMore, true);
});

test('a tab that never answered is its own stop reason, not an empty inbox', async () => {
  const { replay } = fakeReplay([{ status: 0, url: TEMPLATE.url, body: '', error: 'no receiving end' }]);

  const result = await walkInbox({ pageTemplate: TEMPLATE, cursor: 'C1', replay, ingest: never, sleep: noSleep });

  assert.equal(result.stopped, 'no-answer');
  assert.equal(result.pages, 0);
  assert.equal(result.cursor, 'C1');
});

test('the page cap is a stop reason, never a silent truncation', async () => {
  const endless = Array.from({ length: 10 }, (_, i) => ({
    status: 200, url: TEMPLATE.url, body: page([`t${i}`], { end: `C${i + 2}`, hasNext: true }),
  }));
  const { replay } = fakeReplay(endless);
  const { ingest } = fakeIngest();

  const result = await walkInbox({ pageTemplate: TEMPLATE, cursor: 'C1', replay, ingest, sleep: noSleep, maxPages: 3 });

  assert.equal(result.stopped, 'cap');
  assert.equal(result.pages, 3);
  assert.equal(result.hasMore, true);
  assert.equal(result.cursor, 'C4');
});

test('a cursor that repeats itself is a stall, not an endless loop', async () => {
  const { replay } = fakeReplay([
    { status: 200, url: TEMPLATE.url, body: page(['t2'], { end: 'C1', hasNext: true }) },
  ]);
  const { ingest } = fakeIngest();

  const result = await walkInbox({ pageTemplate: TEMPLATE, cursor: 'C1', replay, ingest, sleep: noSleep });

  assert.equal(result.stopped, 'stalled');
  assert.equal(result.pages, 1);
});

test('no pagination template and no cursor are separate answers, and neither sends a request', async () => {
  const noTemplate = await walkInbox({ pageTemplate: null, cursor: 'C1', replay: never, ingest: never, sleep: noSleep });
  assert.equal(noTemplate.stopped, 'no-template');
  assert.equal(noTemplate.pages, 0);

  const noCursor = await walkInbox({ pageTemplate: TEMPLATE, cursor: null, replay: never, ingest: never, sleep: noSleep });
  assert.equal(noCursor.stopped, 'no-cursor');
  assert.equal(noCursor.pages, 0);
});

test('a template whose body has no variables field cannot be paginated', async () => {
  const result = await walkInbox({
    pageTemplate: { ...TEMPLATE, body: 'av=1&doc_id=999' },
    cursor: 'C1', replay: never, ingest: never, sleep: noSleep,
  });
  assert.equal(result.stopped, 'bad-template');
  assert.equal(result.pages, 0);
});

test('a page that parses into nothing stops the walk and says so', async () => {
  const { replay } = fakeReplay([{ status: 200, url: TEMPLATE.url, body: page([], { end: 'C2', hasNext: true }) }]);
  const { ingest } = fakeIngest();

  const result = await walkInbox({ pageTemplate: TEMPLATE, cursor: 'C1', replay, ingest, sleep: noSleep });

  assert.equal(result.stopped, 'empty');
  assert.equal(result.pages, 0);
});

test('a page of threads already stored is progress, not a reason to stop', async () => {
  const { replay } = fakeReplay([
    { status: 200, url: TEMPLATE.url, body: page(['t2'], { end: 'C2', hasNext: true }) },
    { status: 200, url: TEMPLATE.url, body: page(['t3'], { end: null, hasNext: false }) },
  ]);
  const ingest = async (body) => ({ threads: JSON.parse(body).data.inbox.threads.edges.length, added: 0, updated: 0, newInbound: 0 });

  const result = await walkInbox({ pageTemplate: TEMPLATE, cursor: 'C1', replay, ingest, sleep: noSleep });

  assert.equal(result.stopped, 'exhausted');
  assert.equal(result.pages, 2);
  assert.equal(result.added, 0);
});

test('every page reports where the walk got to, so a killed worker can resume', async () => {
  const { replay } = fakeReplay([
    { status: 200, url: TEMPLATE.url, body: page(['t2'], { end: 'C2', hasNext: true }) },
    { status: 200, url: TEMPLATE.url, body: page(['t3'], { end: null, hasNext: false }) },
  ]);
  const { ingest } = fakeIngest();
  const seen = [];

  await walkInbox({ pageTemplate: TEMPLATE, cursor: 'C1', replay, ingest, sleep: noSleep, onPage: (s) => seen.push(s) });

  assert.deepEqual(seen, [
    { pages: 1, cursor: 'C2', hasMore: true, added: 1, updated: 0, newInbound: 0 },
    { pages: 2, cursor: null, hasMore: false, added: 2, updated: 0, newInbound: 0 },
  ]);
});

test('requests are paced apart, one wait per request', async () => {
  const { replay } = fakeReplay([
    { status: 200, url: TEMPLATE.url, body: page(['t2'], { end: 'C2', hasNext: true }) },
    { status: 200, url: TEMPLATE.url, body: page(['t3'], { end: null, hasNext: false }) },
  ]);
  const { ingest } = fakeIngest();
  const waits = [];

  await walkInbox({ pageTemplate: TEMPLATE, cursor: 'C1', replay, ingest, paceMs: 700, sleep: async (ms) => waits.push(ms) });

  assert.deepEqual(waits, [700, 700]);
});

// ── walkThread ────────────────────────────────────────────────────────────

/** One page of a conversation, as `/api/v1/direct_v2/threads/<id>/` sends it. */
function history(itemIDs, { older, cursor }) {
  return JSON.stringify({
    thread: {
      viewer_id: '55501',
      items: itemIDs.map((id) => ({ item_id: id, user_id: '778899', timestamp: 1754500000000000, text: id })),
      has_older: older,
      oldest_cursor: cursor,
    },
  });
}

function fakePages(bodies) {
  const asked = [];
  const page = async (cursor) => {
    asked.push(cursor);
    return { status: 200, url: 'https://www.instagram.com/api/v1/direct_v2/threads/1/', body: bodies[asked.length - 1] };
  };
  return { page, asked };
}

const countIngest = () => {
  const seen = [];
  return { ingest: async (parsed) => { seen.push(parsed.messages.length); return { added: parsed.messages.length }; }, seen };
};

test('a conversation is walked backwards until Instagram runs out of older messages', async () => {
  const { page, asked } = fakePages([
    history(['m9', 'm8'], { older: true, cursor: 'OLD1' }),
    history(['m7', 'm6'], { older: true, cursor: 'OLD2' }),
    history(['m5'], { older: false, cursor: null }),
  ]);
  const { ingest, seen } = countIngest();

  const result = await walkThread({ page, ingest, sleep: noSleep });

  assert.equal(result.stopped, 'exhausted');
  assert.equal(result.pages, 3);
  assert.equal(result.added, 5);
  assert.deepEqual(seen, [2, 2, 1]);
  // First page has no cursor; each later one asks for the cursor it was given.
  assert.deepEqual(asked, [null, 'OLD1', 'OLD2']);
});

test('an ignored cursor param is a stall, not a loop over the same page', async () => {
  const { page, asked } = fakePages([
    history(['m9'], { older: true, cursor: 'SAME' }),
    history(['m9'], { older: true, cursor: 'SAME' }),
  ]);
  const { ingest } = countIngest();

  const result = await walkThread({ page, ingest, sleep: noSleep });

  assert.equal(result.stopped, 'stalled');
  assert.equal(result.pages, 2);
  assert.equal(asked.length, 2, 'it must not keep asking for a cursor Instagram is ignoring');
});

test('a rate limit during a conversation walk stops it and says the history is unfinished', async () => {
  const asked = [];
  const page = async (cursor) => {
    asked.push(cursor);
    return asked.length === 1
      ? { status: 200, url: 'u', body: history(['m9'], { older: true, cursor: 'OLD1' }) }
      : { status: 429, url: 'u', body: '' };
  };
  const { ingest } = countIngest();

  const result = await walkThread({ page, ingest, sleep: noSleep });

  assert.equal(result.stopped, 'block:rateLimited');
  assert.equal(result.pages, 1);
  assert.equal(result.hasMore, true);
});

test('a body that is not a conversation stops the walk instead of counting as done', async () => {
  const page = async () => ({ status: 200, url: 'u', body: 'not json' });
  const { ingest } = countIngest();

  const result = await walkThread({ page, ingest, sleep: noSleep });

  assert.equal(result.stopped, 'parse');
  assert.equal(result.pages, 0);
});

test('a very long conversation stops at the cap and says it is unfinished', async () => {
  const page = async () => ({ status: 200, url: 'u', body: history(['m'], { older: true, cursor: `C${Math.random()}` }) });
  const { ingest } = countIngest();

  const result = await walkThread({ page, ingest, sleep: noSleep, maxPages: 4 });

  assert.equal(result.stopped, 'cap');
  assert.equal(result.pages, 4);
  assert.equal(result.hasMore, true);
});

test('a stalled walk hands over the page that stalled it', async () => {
  // The page Instagram answered with IS the evidence of why it stalled, and it
  // is gone the moment the walk returns.
  const stuck = page(['t2'], { end: 'C1', hasNext: true });
  const { replay } = fakeReplay([{ status: 200, url: TEMPLATE.url, body: stuck }]);
  const { ingest } = fakeIngest();
  const handed = [];

  const result = await walkInbox({
    pageTemplate: TEMPLATE, cursor: 'C1', replay, ingest, sleep: noSleep, onStuck: (b) => handed.push(b),
  });

  assert.equal(result.stopped, 'stalled');
  assert.deepEqual(handed, [stuck]);
});

test('a walk that ends properly hands over nothing', async () => {
  const { replay } = fakeReplay([{ status: 200, url: TEMPLATE.url, body: page(['t2'], { end: null, hasNext: false }) }]);
  const { ingest } = fakeIngest();
  const handed = [];

  await walkInbox({ pageTemplate: TEMPLATE, cursor: 'C1', replay, ingest, sleep: noSleep, onStuck: (b) => handed.push(b) });

  assert.deepEqual(handed, []);
});

// ── scrolling the list, when replaying its request is not on offer ────────────

/** A list whose stored count moves by `increments[n]` on the n-th scroll. */
function scripted(increments) {
  let threads = 100;
  let round = 0;
  const scroll = async () => {
    const step = increments[round];
    round += 1;
    if (step === undefined) throw new Error(`scrolled ${round} times, script has ${increments.length}`);
    threads += step;
    return { ok: true, top: round * 900, height: threads * 72 };
  };
  return { scroll, count: async () => threads };
}

test('scrolls on while conversations keep arriving, and stops once they stop', async () => {
  const { scroll, count } = scripted([20, 20, 20, 0, 0]);

  const result = await scrollInbox({ scroll, count, sleep: noSleep, quietRounds: 2 });

  assert.equal(result.stopped, 'quiet');
  assert.equal(result.rounds, 5);
  assert.equal(result.threads, 160);
  assert.equal(result.gained, 60);
});

test('a pause shorter than the limit does not end the walk', async () => {
  // Instagram answers a page later than the round it was asked in, so patience
  // has to reset on growth — otherwise a slow page ends the walk as "finished".
  const { scroll, count } = scripted([20, 0, 0, 20, 0, 0, 0]);

  const result = await scrollInbox({ scroll, count, sleep: noSleep, quietRounds: 3 });

  assert.equal(result.stopped, 'quiet');
  assert.equal(result.rounds, 7);
  assert.equal(result.gained, 40);
});

test('a page with no list on it stops instead of scrolling at nothing', async () => {
  const scroll = async () => ({ ok: false, error: 'no-list' });
  const result = await scrollInbox({ scroll, count: async () => 100, sleep: noSleep });

  assert.equal(result.stopped, 'scroll:no-list');
  assert.equal(result.rounds, 0);
  assert.equal(result.gained, 0);
});

test('a walk that stops quiet carries what the page last reported', async () => {
  // "Nothing new" and "the container never moved" are the same result from the
  // outside, and only one of them means the inbox is finished.
  const { scroll, count } = scripted([0, 0]);

  const result = await scrollInbox({ scroll, count, sleep: noSleep, quietRounds: 2 });

  assert.equal(result.stopped, 'quiet');
  assert.deepEqual(result.view, { ok: true, top: 1800, height: 7200 });
});

test('a list that never runs out stops at the cap and says it is unfinished', async () => {
  let threads = 100;
  const scroll = async () => { threads += 20; return { ok: true, top: threads, height: threads * 72 }; };

  const result = await scrollInbox({ scroll, count: async () => threads, sleep: noSleep, maxRounds: 4 });

  assert.equal(result.stopped, 'cap');
  assert.equal(result.rounds, 4);
  assert.equal(result.gained, 80);
});

test('every round is reported while it is still running', async () => {
  const { scroll, count } = scripted([20, 0, 0]);
  const seen = [];

  await scrollInbox({ scroll, count, sleep: noSleep, quietRounds: 2, onRound: (state) => seen.push(state) });

  assert.equal(seen.length, 3);
  assert.deepEqual(seen.map((s) => s.threads), [120, 120, 120]);
  assert.deepEqual(seen.map((s) => s.gained), [20, 20, 20]);
  assert.equal(seen[2].rounds, 3);
});

test('the count is read after the wait, not before it', async () => {
  // A round that checks before Instagram has had time to answer sees no growth
  // every time, and stops a walk that was working.
  const order = [];
  const scroll = async () => { order.push('scroll'); return { ok: true, top: 1, height: 2 }; };
  const result = await scrollInbox({
    scroll,
    count: async () => { order.push('count'); return 100; },
    sleep: async () => { order.push('wait'); },
    quietRounds: 1,
  });

  assert.equal(result.stopped, 'quiet');
  assert.deepEqual(order, ['count', 'scroll', 'wait', 'count']);
});
