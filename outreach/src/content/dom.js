// dom.js — generic page helpers: waiting, visibility, aim geometry. Nothing
// here knows anything about Instagram.
//
// THE CONTENT LAYER IS SEVERAL FILES sharing one isolated world, injected in a
// fixed order (manifest.json, and CONTENT_SCRIPTS in background.js for the
// re-injection path):
//
//     dom → hands → input → finders → direct → post → story → main
//
// They share one namespace object and each file takes its dependencies from it
// at load time, so the order is load-bearing: a file may only use what an
// EARLIER one publishes.

(() => {
  "use strict";
  const S = (globalThis.__igs ||= {});

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const handle = (s) => norm(s).toLowerCase().replace(/^@+/, "");
  const humanPause = (min = 900, max = 2200) => sleep(rand(min, max));

  // Fire-and-forget progress line → surfaces in the extension page's run log, so the
  // click-chain is observable (which step reached, where it diverged).
  const step = (text) => { chrome.runtime.sendMessage({ type: "STEP", text }).catch(() => {}); };

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }

  async function waitFor(fn, timeout = 7000, interval = 250) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try {
        const v = fn();
        if (v) return v;
      } catch (_e) { /* keep polling */ }
      await sleep(interval);
    }
    return null;
  }

  // Where on the element to aim: inside the middle 60%, never dead centre —
  // and never the outer edge, which usually belongs to a padding wrapper.
  function clickPointOf(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return {
      x: Math.round(r.left + r.width * rand(0.2, 0.8)),
      y: Math.round(r.top + r.height * rand(0.2, 0.8)),
    };
  }

  const inViewport = (p) => p.x > 2 && p.y > 2 && p.x < innerWidth - 2 && p.y < innerHeight - 2;

  // Is our aim point really this element, or is something drawn over it?
  const aimIsClear = (el, p) => {
    const top = document.elementFromPoint(p.x, p.y);
    return !!top && (top === el || el.contains(top) || top.contains(el));
  };

  // The scrollport this element lives in, if any. IG hangs its lists (the
  // inbox, the share sheet's recipients) inside overflow containers.
  function scrollParent(el) {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const overflow = getComputedStyle(p).overflowY;
      if (/auto|scroll|overlay/.test(overflow) && p.scrollHeight > p.clientHeight + 4) return p;
    }
    return null;
  }

  const rectInside = (r, frame) => r.top >= frame.top - 1 && r.bottom <= frame.bottom + 1;

  Object.assign(S, {
    sleep, rand, norm, handle, humanPause, step,
    isVisible, waitFor, clickPointOf, inViewport, aimIsClear, scrollParent, rectInside,
  });
})();
