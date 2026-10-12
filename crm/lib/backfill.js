// Walking the inbox backwards, page by page, until Instagram runs out.
//
// A refresh reads the TOP of the inbox: one request, one page, whatever is
// newest. That is the right thing for "what changed since I looked" and the
// wrong thing for "give me everything" — the rest of the list only ever arrived
// here because somebody scrolled the linked tab by hand.
//
//   cursor ──▶ swap it into the pagination request ──▶ replay ──▶ ingest
//      ▲                                                            │
//      └──────────── the cursor that page handed back ◀─────────────┘
//
// Two ways of asking, because Instagram answers to two. A CONVERSATION's history
// is fetched by a query whose variables name the thread, so pointing it at
// another thread and another cursor works — that is walkThread. The LIST is not:
// the query that takes a cursor is only ever issued by Instagram's own virtual
// list, when it decides it needs the next chunk, and it will not take a cursor
// spliced into the mailbox query that loads the first page. So the list is
// walked by scrolling — scrollInbox below — and the hook stores what Instagram
// fetches on its own.
//
// Nothing here touches chrome.*: `replay`, `ingest`, `scroll` and `count` come
// from the worker, which is what makes the walks testable without a browser.

import { threadListCursor, swapInboxCursor, classifyInboxBlock, parseConversation } from './parser.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Why the walk ended is part of its result, never a shrug. A run that stopped
 * at the cap looks exactly like a finished one from the outside, and "we have
 * everything" is the one wrong belief nothing downstream can catch.
 */
export async function walkInbox({
  pageTemplate,
  cursor,
  replay,
  ingest,
  onPage,
  onStuck,
  sleep = wait,
  paceMs = 900,
  maxPages = 400,
}) {
  const totals = { added: 0, updated: 0, newInbound: 0 };
  let pages = 0;
  let at = cursor ?? null;
  const done = (stopped, hasMore) => ({ ...totals, pages, cursor: at, hasMore, stopped });

  // The pagination request is captured from Instagram's own scroll, so before
  // the inbox has ever been scrolled in a hooked tab there is nothing to replay.
  if (!pageTemplate?.body) return done('no-template', true);
  if (!at) return done('no-cursor', true);

  while (pages < maxPages) {
    const body = swapInboxCursor(pageTemplate.body, at);
    if (!body) return done('bad-template', true);

    await sleep(paceMs);
    const response = await replay({ ...pageTemplate, body });

    const block = classifyInboxBlock(response?.status ?? 0, response?.url ?? '', response?.body ?? '');
    if (block) return done(`block:${block}`, true);
    // Status 0 is the tab, not Instagram: no content script, tab closed
    // mid-walk. Calling that an empty inbox would end the walk as "done".
    if (!response?.status) return done('no-answer', true);

    const counts = await ingest(response?.body ?? '');
    // Zero threads out of a page means the shape moved or the session ended —
    // asking for the next cursor after that is asking a stranger.
    if (!counts?.threads) return done('empty', true);

    pages += 1;
    totals.added += counts.added ?? 0;
    totals.updated += counts.updated ?? 0;
    totals.newInbound += counts.newInbound ?? 0;

    const next = threadListCursor([response.body]);
    const hasMore = next?.hasNext === true;
    const previous = at;
    at = hasMore ? next.end ?? null : null;
    await onPage?.({ pages, cursor: at, hasMore, ...totals });

    if (!hasMore) return done('exhausted', false);
    // A cursor that comes back unchanged would walk the same page forever. It
    // also means Instagram did not take the one we sent — the page we are
    // holding is the answer to that, so hand it to whoever can look at it.
    if (!at || at === previous) {
      at = previous;
      await onStuck?.(response.body ?? '');
      return done('stalled', true);
    }
  }
  return done('cap', true);
}

/**
 * One conversation, newest page first, following `oldest_cursor` back through
 * its history. The inbox payload carries only the last message or two, so this
 * is the only way a thread nobody opened gets a readable history.
 *
 * `page(cursor)` fetches; `ingest(parsedPage)` stores. Both come from the
 * worker, for the same reason as walkInbox.
 */
export async function walkThread({ page, ingest, sleep = wait, paceMs = 900, maxPages = 20 }) {
  let pages = 0;
  let added = 0;
  let cursor = null;

  while (pages < maxPages) {
    await sleep(paceMs);
    const response = await page(cursor);

    const block = classifyInboxBlock(response?.status ?? 0, response?.url ?? '', response?.body ?? '');
    if (block) return { pages, added, stopped: `block:${block}`, hasMore: true };
    if (!response?.status) return { pages, added, stopped: 'no-answer', hasMore: true };

    const parsed = parseConversation(response.body ?? '');
    if (!parsed) return { pages, added, stopped: 'parse', hasMore: true };

    const result = await ingest(parsed);
    pages += 1;
    added += result?.added ?? 0;

    if (!parsed.hasOlder) return { pages, added, stopped: 'exhausted', hasMore: false };
    // Instagram handing back the cursor we just asked with means it did not
    // take it — one more request would fetch this same page again forever.
    if (!parsed.oldestCursor || parsed.oldestCursor === cursor) {
      return { pages, added, stopped: 'stalled', hasMore: true };
    }
    cursor = parsed.oldestCursor;
  }
  return { pages, added, stopped: 'cap', hasMore: true };
}

/**
 * The rest of the inbox, by driving Instagram's own infinite scroll: push the
 * list to the bottom, wait for the chunk it fetches, repeat until nothing new
 * arrives. The hook stores what comes back, so `count` — the number of
 * conversations on disk — is the only progress signal that matters. The DOM is
 * not one: the list is virtualized, and rows that were never rendered were
 * still fetched.
 *
 * Patience, not a page count, decides when to stop: Instagram answers a page a
 * beat after the round that asked for it, so a single empty round means nothing
 * and `quietRounds` of them in a row mean the list has ended.
 *
 * Only works while the tab is producing frames. A window on another Space, or
 * one fully covered, is occluded and Chrome stops rendering it — no frames, no
 * IntersectionObserver, no next chunk, and this would spin through its rounds
 * finding nothing. The worker turns frames back on with focus emulation before
 * it calls (outreach/src/cdp.js keepRendering, measured in
 * outreach/test/occlusion.test.mjs).
 */
export async function scrollInbox({
  scroll,
  count,
  onRound,
  sleep = wait,
  paceMs = 1200,
  quietRounds = 4,
  maxRounds = 600,
}) {
  const start = await count();
  let threads = start;
  let rounds = 0;
  let quiet = 0;
  let view = null;
  const done = (stopped) => ({ rounds, threads, gained: threads - start, stopped, view });

  while (rounds < maxRounds) {
    view = await scroll();
    // No list on the page, or no page. Scrolling on would be scrolling at
    // nothing, once a second, until the cap.
    if (!view?.ok) return done(`scroll:${view?.error ?? 'failed'}`);
    rounds += 1;

    // Instagram is fetching the next chunk during this wait. Counting before it
    // answers reads every working round as a round that brought nothing.
    await sleep(paceMs);
    const now = await count();
    quiet = now > threads ? 0 : quiet + 1;
    threads = now;
    await onRound?.({ rounds, threads, gained: threads - start, quiet });

    if (quiet >= quietRounds) return done('quiet');
  }
  return done('cap');
}
