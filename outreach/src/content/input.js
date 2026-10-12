// input.js — how we touch the page, and how we tell whether the touch took.
//
// Every click, keystroke and scroll is dispatched by the background worker
// through chrome.debugger, so the page sees genuine trusted events with a
// cursor that actually travels between targets. This file decides WHERE to
// aim; src/cdp.js does the moving and pressing. Failures throw — a click that
// silently went nowhere is exactly the bug class this replaces.

(() => {
  "use strict";
  const S = globalThis.__igs;
  const {
    sleep, rand, norm, step, humanPause, waitFor, isVisible,
    clickPointOf, inViewport, aimIsClear, scrollParent, rectInside, hands,
  } = S;

  // How many messages this page has submitted — see submitsMade below, and the
  // abandon rule that reads it.
  let submits = 0;

  // A send nobody is waiting for any more must stop touching the page. The
  // worker gives up on a lead (its own timeout, or too many reloads under it)
  // and moves to the next one, while this page is still clicking away for the
  // old lead — and the next lead was then answered with "busy sending to
  // @someone", three in a row, which stops the whole run.
  //
  // Cancelling is only safe BEFORE the message goes out, so the abandon is
  // pinned to the submit count: once something has been submitted the send plays
  // out to the end (seconds) rather than leaving a message half-sent and the
  // lead marked failed.
  let abandonAt = null;
  const abandonSend = () => { abandonAt = submits; };
  const resumeSends = () => { abandonAt = null; };
  const sendWasAbandoned = () => abandonAt !== null && submits === abandonAt;

  // The one funnel every click, keystroke and scroll passes through — which is
  // also why the hands on screen are driven from here and nowhere else. They are
  // let go in `finally`, so a dip lasts exactly as long as the real input does.
  // It is also the one place an abandoned send can be stopped.
  async function input(op, data = {}) {
    if (sendWasAbandoned()) throw new Error("this lead was abandoned — the worker moved on");
    const letGo = hands.press(op, data);
    try {
      const res = await chrome.runtime.sendMessage({ type: "INPUT", op, ...data });
      if (!res || !res.ok) throw new Error((res && res.error) || `input.${op} failed`);
      return res;
    } finally {
      letGo();
    }
  }

  const pressEnter = () => input("key", { key: "Enter" });
  const pressEscape = () => input("key", { key: "Escape" });

  // Work out a point where this element can genuinely be clicked. A coordinate
  // click needs the target both on screen and actually painted there: an
  // element clipped by its scrollport still reports in-viewport coordinates
  // while nothing of it is drawn at them (verified live on IG's inbox list), so
  // the check has to be "does this point resolve to the target", not "is it in
  // the viewport". Scrolling is done with the cursor over the right container.
  async function aimAt(el) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const point = clickPointOf(el);
      if (!point) return null;
      if (inViewport(point) && aimIsClear(el, point)) return point;

      const r = el.getBoundingClientRect();
      const box = scrollParent(el);
      const frame = box ? box.getBoundingClientRect() : new DOMRect(0, 0, innerWidth, innerHeight);
      // Fully inside its frame and on screen, yet the point isn't ours →
      // scrolling will not reveal it; something is on top.
      if (inViewport(point) && rectInside(r, frame)) return null;

      const delta = r.top < frame.top ? r.top - frame.top - 40 : r.bottom - frame.bottom + 40;
      if (box) {
        await input("move", {
          x: Math.round(frame.left + frame.width / 2),
          y: Math.round(frame.top + frame.height / 2),
        });
      }
      await input("wheel", { dy: Math.round(Math.max(-500, Math.min(500, delta))) });
      await sleep(rand(220, 420));
    }
    return null;
  }

  // Why the aim failed. Three different bugs end up here — a node that went
  // away, a target nothing can scroll to, and a target with something on top —
  // and they need different fixes, so the log has to tell them apart.
  function aimProblem(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return "the element went away before the click (detached)";
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) {
      return `off-screen at ${Math.round(r.left)},${Math.round(r.top)} in a ${innerWidth}×${innerHeight} viewport, and nothing scrolls it back`;
    }
    const x = Math.round(Math.min(innerWidth - 3, Math.max(3, r.left + r.width / 2)));
    const y = Math.round(Math.min(innerHeight - 3, Math.max(3, r.top + r.height / 2)));
    const top = document.elementFromPoint(x, y);
    if (!top) return `nothing is painted at ${x},${y} where it should be`;
    const aria = top.getAttribute("aria-label");
    return `covered by <${top.tagName.toLowerCase()}${aria ? ` aria-label="${aria}"` : ""}> at ${x},${y}`;
  }

  async function realClick(el) {
    if (!el) throw new Error("nothing to click");
    let point = await aimAt(el);
    if (!point) {
      await dismissNagModals();        // the usual reason something is on top
      point = await aimAt(el);
      if (!point) throw new Error(`no clear shot at the target — ${aimProblem(el)}`);
    }
    await input("click", point);
  }

  // ── typing, and proving it landed ────────────────────────────────────────────
  // What a field reads as text, whatever kind of field it is: `value` for an
  // input, and for the contenteditable IG composes in, innerText — which is the
  // RENDERED text. textContent would be wrong here: a soft line break is a <br>
  // (or, in Lexical, a paragraph) and contributes no character at all, so a
  // two-line message would read back as "firstsecond" and never match itself.
  const fieldText = (el) => (el && (el.value ?? el.innerText)) || "";

  // Zero-width characters ride along inside emoji and are invisible in the
  // field — comparing them would report a difference nobody can see.
  const visible = (s) => norm(String(s).replace(/[\u200b-\u200d\ufeff]/g, ""));
  const clip = (s) => (s.length > 60 ? `${s.slice(0, 57)}…` : s);

  // What THIS field can actually hold. A line break is typed as Shift+Enter, and
  // a single-line <input> cannot take one: measured on real Chrome, the break
  // lands as no character at all, so "asf\nI am" reads back as "asfI am" and a
  // two-line message can never match itself — three attempts, twice over, and
  // the lead is dropped without a word going out. (Inside a <form> that same
  // keystroke submits, too.) The share sheet's "Write a message…" is exactly
  // such an input, so a message with a break in it goes out there on one line.
  const isOneLine = (el) => el.tagName === "INPUT";
  const flatten = (s) => s.replace(/[ \t]*\n+[ \t]*/g, " ");

  // Put exactly `text` in a field, and prove it is what the field holds.
  //
  // Three different things end up here and from the outside they look identical:
  // the field re-renders and the keystrokes go into a node that is no longer on
  // the page, something takes focus mid-word (a nag modal — or the person's own
  // cursor, since the work window is a real one they can click in), or the clear
  // didn't clear. Typing again ON TOP of what is there is how one handle reached
  // the search box as two overlapping copies, so every attempt starts by
  // clearing and ends by reading the field back. Returns null when the field
  // holds the text, else a reason naming what it holds instead.
  //
  // Takes a FINDER, not a field: these surfaces re-render under us, and a node
  // resolved even a second ago can be detached by the time we touch it.
  async function fillField(findField, text, speed, attempts = 3) {
    let problem = "";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) await humanPause(400, 900);
      const field = await waitFor(findField, 6000);
      try {
        if (!field) throw new Error("the field never appeared");
        const want = isOneLine(field) ? flatten(text) : text;
        if (want !== text && attempt === 1) step("this field holds one line — the break goes in as a space");
        await realClick(field);
        await sleep(rand(150, 400));
        await input("clear");
        await input("type", { text: want, speed });
        await sleep(rand(200, 450));        // React writes its own value back a tick later
        const reads = visible(fieldText(findField() || field));
        if (reads === visible(want)) return null;
        problem = `it reads "${clip(reads)}"`;
      } catch (e) {
        problem = e.message;
      }
      if (attempt < attempts) {
        step(`typing "${clip(visible(text))}" didn't take — ${problem}; clearing it and trying again`);
      }
    }
    return `couldn't type "${clip(visible(text))}" — ${problem}`;
  }

  // ── nag modals ────────────────────────────────────────────────────────────────
  // "Turn on Notifications" / "Save login info" etc. pop over the composer and steal
  // focus. Click only an explicit decline button (safe to run blind).
  const DECLINE_RE = /^(not now|not right now|maybe later|ask again later|remind me later|skip|dismiss|no thanks|nicht jetzt|jetzt nicht|später|spater|ahora no|más tarde|mas tarde|non ora|più tardi|piu tardi|pas maintenant|plus tard|не сейчас|позже|не теперь|напомнить позже|пропустить|agora não|agora nao|mais tarde|depois)$/i;
  async function dismissNagModals() {
    for (let pass = 0; pass < 3; pass++) {
      const btn = [...document.querySelectorAll('[role="button"], button')]
        .filter(isVisible)
        .find((b) => DECLINE_RE.test(norm(b.textContent)));
      if (!btn) break;
      const point = clickPointOf(btn);
      if (!point || !inViewport(point)) break;
      await input("click", point);       // not realClick: that calls back into here
      await sleep(rand(400, 900));
    }
  }

  // ── Instagram's own error page ────────────────────────────────────────────────
  // "Произошла ошибка / Не удалось загрузить страницу", with a Reload button.
  // Instagram throws it on a client-side navigation that failed, and the page
  // behind it is EMPTY — which every finder in this layer reads as a profile with
  // no posts and no stories. The run then quietly drops to a plain DM instead of
  // the format that was asked for, and the log says "no posts to reply to" about
  // a profile it never actually saw. Pressing Instagram's own button fixes it.
  const PAGE_ERROR_RE = /произошла ошибка|возникла проблема|не удалось загрузить|something went wrong|couldn'?t load|page could not be loaded|an error occurred/i;
  const RELOAD_RE = /^(обновить страницу|обновить|перезагрузить страницу|повторить попытку|попробовать снова|reload page|refresh page|reload|refresh|try again)$/i;

  const findReloadButton = () =>
    [...document.querySelectorAll('[role="button"], button, a')].filter(isVisible)
      .find((b) => RELOAD_RE.test(norm(b.textContent))) || null;

  // Both signals, never the words alone: a lead can write "произошла ошибка" in a
  // message, and reloading the page in the middle of their thread would throw the
  // send away. Instagram's normal UI has no standalone Reload button — the same
  // discipline detectRefusal already follows for block wording.
  const pageFailedToLoad = () =>
    PAGE_ERROR_RE.test(norm((document.body && document.body.innerText) || "")) && !!findReloadButton();

  // An empty page and a broken page look identical to every finder in this
  // layer: no posts, no stories, no highlights. And Instagram's error screen does
  // NOT arrive with the navigation — it shows up a second or two later, so the
  // one check made on arrival looks at a page that is merely still loading and
  // waves it through. That is how a profile the run never actually saw was
  // reported as having no story and no posts, and the send quietly dropped to a
  // plain DM (log: "opening the first highlight / story takes no replies / no
  // posts to reply to" on a page showing "Something went wrong").
  //
  // So the check belongs where the empty conclusion is drawn, not where the
  // navigation happened. True means the page WAS broken and has been reloaded —
  // whatever was just looked for deserves another look.
  async function pageWasBroken() {
    if (!pageFailedToLoad()) return false;
    await recoverPageError();
    return true;
  }

  // Returns true if the page is usable when this resolves. The reload is a real
  // navigation, so this content script may be torn down mid-await — the worker's
  // retry covers that case, which is exactly what it is for.
  async function recoverPageError() {
    if (!pageFailedToLoad()) return true;
    for (let attempt = 0; attempt < 2; attempt++) {
      const btn = findReloadButton();
      if (!btn) break;
      step("Instagram couldn't load the page — pressing its Reload");
      await realClick(btn);
      if (await waitFor(() => (pageFailedToLoad() ? null : true), 12000)) return true;
    }
    return !pageFailedToLoad();
  }

  // ── scrolling gestures ────────────────────────────────────────────────────────
  // Flick back up rather than snapping there in one frame.
  async function scrollToTop() {
    for (let i = 0; i < 10 && scrollY > 0; i++) {
      await input("wheel", { dy: -Math.round(rand(400, 700)) });
      await sleep(rand(180, 340));
    }
  }

  async function humanScrollProfile(times) {
    for (let i = 0; i < (times || 0); i++) {
      await input("wheel", { dy: Math.round(rand(300, 700)) });
      await humanPause(700, 1500);
    }
    await input("wheel", { dy: -Math.round(rand(60, 180)) }); // the small scroll back everyone does
    await humanPause(400, 900);
  }

  // ── did it go out? ────────────────────────────────────────────────────────────
  // Instagram pushing back, in two kinds — and the difference decides whether
  // the run may continue:
  //   · blocked — an action block or a rate limit. The next lead walks into the
  //     same wall, so the run must stop instead of hammering the account.
  //   · a plain send failure — this one message didn't go out; the next lead is
  //     still worth trying.
  // The block wording is read ONLY out of dialogs and alerts, never the whole
  // page: we now stand inside the lead's conversation, and their own messages
  // are body text that could say anything ("try again later" included). A block
  // is always a modal, so scoping it there costs nothing and stops a stranger's
  // wording from killing the run.
  const BLOCK_RE = [
    /action blocked/, /we restrict certain activity/, /try again later/, /please wait a few minutes/,
    /temporarily blocked/, /temporarily restricted/,
    /действие заблокировано/, /вы временно заблокированы/, /ограничили некоторые действия/, /попробуйте позже/,
    /aktion blockiert/, /vorübergehend gesperrt/,
    /acción bloqueada/, /bloqueado temporalmente/,
    /azione bloccata/, /temporaneamente bloccato/,
    /action bloquée/, /temporairement bloqué/,
  ];
  const SEND_FAIL_RE = [
    /couldn'?t send/, /could not be sent/, /not delivered/, /something went wrong/,
    /nicht zugestellt/, /konnte nicht gesendet werden/, /no se pudo enviar/,
    /не отправлено/, /не удалось отправить/,
  ];

  function detectRefusal() {
    const dialogs = [...document.querySelectorAll('div[role="dialog"], [role="alert"]')]
      .map((b) => b.innerText || "").join(" ").toLowerCase();
    for (const re of BLOCK_RE) {
      const m = dialogs.match(re);
      if (m) return { blocked: true, text: m[0] };
    }
    const page = ((document.body && document.body.innerText) || "").toLowerCase();
    for (const re of SEND_FAIL_RE) {
      const m = page.match(re);
      if (m) return { blocked: false, text: m[0] };
    }
    return null;
  }

  // A lead that failed on the way in is worth starting over; one that failed
  // AFTER this number moved is not, since the message may well have gone out.
  // Read by main.js before it retries, and by the abandon rule above.
  const submitsMade = () => submits;


  // The last few centimetres of every send path: fill the field, submit the way
  // THAT surface submits, then look for a refusal. Takes a finder for the same
  // reason fillField does — the story viewer swaps its whole card while the item
  // plays, the share sheet rebuilds as results arrive.
  async function typeAndSubmit(findField, message, speed, { submit }) {
    await dismissNagModals();
    await humanPause(500, 1100);
    // Nothing is submitted until the field provably holds the message. This is
    // the one keystroke in the run that cannot be taken back: a shredded message
    // is delivered to a real person, and a lead did once receive one sentence
    // typed twice into itself. A message that won't go in cleanly is a failed
    // lead, never a sent one.
    const problem = await fillField(findField, message, speed);
    if (problem) return { status: "failed", error: problem };
    await sleep(rand(400, 900));
    submits++;                             // the point of no return — see submitsMade
    await submit();
    await sleep(rand(800, 1400));
    const refusal = detectRefusal();
    if (!refusal) return { status: "sent" };
    return refusal.blocked
      ? { status: "blocked", error: refusal.text }
      : { status: "failed", error: refusal.text };
  }

  Object.assign(S, {
    input, pressEnter, pressEscape, aimAt, realClick, dismissNagModals,
    fillField, scrollToTop, humanScrollProfile, detectRefusal, typeAndSubmit, submitsMade,
    abandonSend, resumeSends, sendWasAbandoned,
    pageFailedToLoad, recoverPageError, pageWasBroken,
  });
})();
