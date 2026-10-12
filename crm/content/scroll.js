// Pushes Instagram's conversation list to the bottom, so Instagram fetches the
// next chunk itself. That is the whole trick: the request that pages the list is
// only ever issued by Instagram's own virtual list, and it will not take a
// cursor from anywhere else — so instead of asking for the next page, we make
// the page ask (crm/lib/backfill.js, scrollInbox).
//
// Nothing here is found by class name: Instagram's are generated and change
// between builds. A row is found by SHAPE and the list by what it holds, the
// same discipline the parser uses on Instagram's payloads.
//
// Wrapped: the outreach half shares this isolated world, so a name declared
// at top level here could collide with one declared there — and a duplicate
// `const` is a SyntaxError that kills the whole content layer, both halves at
// once. Nothing in this file needs to be visible outside it.
(() => {
  // Two shapes, because Instagram draws the list both ways. The cell is the one
  // verified against the live UI by the send half: a role=button tabindex=0 box
  // about 72px tall carrying an avatar (outreach/src/content/direct.js).
  const LINK = 'a[href*="/direct/t/"]';
  const CELL = 'div[role="button"][tabindex="0"]';
  const BOXES = 'div, section, ul';

  const scrolls = (el) =>
    el.scrollHeight > el.clientHeight + 8 && /auto|scroll|overlay/.test(getComputedStyle(el).overflowY);

  // Frames actually produced since this script loaded. Everything here depends
  // on the tab rendering — no frames, no IntersectionObserver, no next chunk —
  // and a tab that is not the one its window shows is not painted at all. This
  // is the difference between "it should be rendering" and knowing.
  let painted = 0;
  const tick = () => { painted += 1; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);

  /** Is this role=button box a conversation row, or one of the page's buttons? */
  function isCell(el) {
    const r = el.getBoundingClientRect();
    return r.width > 200 && r.height > 40 && r.height < 130 && Boolean(el.querySelector('img'));
  }

  const rowsIn = (root) =>
    root.querySelectorAll(LINK).length || [...root.querySelectorAll(CELL)].filter(isCell).length;

  /** The nearest ancestor of `row` that scrolls, or null. */
  function scrollerOf(row) {
    for (let el = row; el && el !== document.body; el = el.parentElement) {
      if (scrolls(el)) return el;
    }
    return null;
  }

  /**
   * The conversation list: of everything on the page that scrolls, the one
   * holding the most conversation rows.
   *
   * Not simply the first row's scroller. A thread page scrolls in two places and
   * the message pane holds a link to the conversation it is showing, so walking
   * up from the first row on the page can land in the pane — and from there the
   * list is sideways, not upwards. Scrolling the pane would report a finished
   * inbox at whatever had already arrived, which is the one wrong answer nothing
   * downstream can catch.
   *
   * `picked` says how the choice was made, because the fallback is a guess. When
   * no row shape matches at all — Instagram redrew them again — the tallest
   * thing that scrolls is still the list far more often than not, so the pass is
   * worth making. What decides whether the guess was right is the number of
   * conversations on disk afterwards, never this function.
   */
  function listScroller() {
    const counted = new Map();
    for (const row of document.querySelectorAll(`${LINK}, ${CELL}`)) {
      const scroller = scrollerOf(row);
      if (!scroller || counted.has(scroller)) continue;
      counted.set(scroller, rowsIn(scroller));
    }
    let best = null;
    let most = 1; // one row is a conversation being shown, not a list
    for (const [el, rows] of counted) if (rows > most) { best = el; most = rows; }
    if (best) return { list: best, rows: most, picked: 'rows' };

    const tallest = [...document.querySelectorAll(BOXES)]
      .filter((el) => scrolls(el) && el.scrollHeight > el.clientHeight * 2)
      .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    return tallest ? { list: tallest, rows: 0, picked: 'tallest' } : null;
  }

  /**
   * What is on this page, in names and numbers only — never text, never hrefs.
   * Carried out through health when the row shapes stop matching, so the next
   * reader is looking at Instagram's real markup instead of guessing at it. Four
   * guesses at that markup have cost a run each.
   */
  function probe() {
    const scrollers = [...document.querySelectorAll(BOXES)].filter(scrolls).map((el) => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        h: Math.round(el.scrollHeight), view: Math.round(el.clientHeight),
        left: Math.round(r.left), width: Math.round(r.width),
        links: el.querySelectorAll(LINK).length,
        cells: el.querySelectorAll(CELL).length,
        imgs: el.querySelectorAll('img').length,
      };
    });
    return {
      path: location.pathname,
      painted,
      state: document.visibilityState,
      focus: document.hasFocus(),
      links: document.querySelectorAll(LINK).length,
      cells: document.querySelectorAll(CELL).length,
      scrollers: scrollers.sort((a, b) => b.h - a.h).slice(0, 6),
    };
  }

  /**
   * Straight to the bottom rather than a screen at a time. The list is
   * virtualized, so the rows jumped over are not rows lost — nothing here reads
   * the DOM for data, and what matters is landing on the sentinel at the end of
   * what is loaded, which is what makes Instagram fetch the next chunk. A wheel
   * would take twenty ticks to cross a list this long; this takes one.
   *
   * The point the worker aims its wheel at comes back with the numbers. An
   * assignment to `scrollTop` moves the list and fires `scroll`, but it cannot
   * produce a `wheel` event, and the send half has been paging this same list
   * with a real wheel for as long as it has existed
   * (outreach/src/content/direct.js, scanInbox) — so the flick that ends the
   * round is the input Instagram is known to answer.
   *
   * Numbers come back so a round that changed nothing can be told apart from a
   * round that scrolled into an inbox that has ended.
   */
  function scrollList() {
    if (!location.pathname.startsWith('/direct/')) return { ok: false, error: 'not-on-direct' };
    const found = listScroller();
    if (!found) return { ok: false, error: 'no-list', probe: probe() };

    const { list, rows, picked } = found;
    list.scrollTop = list.scrollHeight;
    const box = list.getBoundingClientRect();
    return {
      ok: true,
      picked,
      rows,
      // Carried every round on purpose: a count that does not move between
      // rounds says the tab is not painting, which is the difference between a
      // finished inbox and a pass that never had a chance.
      painted,
      top: Math.round(list.scrollTop),
      height: Math.round(list.scrollHeight),
      x: Math.round(box.left + box.width / 2),
      y: Math.round(box.top + box.height / 2),
      // Only when the choice was a guess: it is the one case where knowing what
      // else was on the page is worth carrying out.
      ...(picked === 'tallest' ? { probe: probe() } : {}),
    };
  }

  const handlers = { 'scroll-list': scrollList, 'scroll-probe': probe };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const handler = handlers[message?.type];
    if (!handler) return undefined;
    try {
      sendResponse(handler());
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message ?? e) });
    }
    return false; // answered synchronously
  });
})();
