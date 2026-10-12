// hands.js — the pair of hands that hangs over the work window while a run is on.
//
// Purely cosmetic, and deliberately inert: the host is pointer-events:none, so it
// can never swallow a click meant for Instagram and document.elementFromPoint —
// which every aim check in input.js goes through — looks straight past it.
//
// The artwork is ONE image of both hands. Each half is its own element, clipped
// to its side of the empty column between them, so a hand can move on its own and
// no seam is ever exposed. Individual fingers cannot move: the artwork is a
// photograph, so which hand reached, and where, is all the resolution there is.

(() => {
  "use strict";
  const S = globalThis.__igs;
  // The worker re-injects the whole content layer when a page stops answering.
  // A second copy must not build a second pair of hands over the first.
  if (S.hands) return;

  const { sleep, rand } = S;

  const ART_VH = 145;                // the artwork's rendered height, in vh
  const ART_VW = 105;                // …but never so tall that the hands outgrow a narrow window
  const REST_VH = 50;                // where the fingertips hang when nothing is happening

  // Which pair of hands. The worker sends the descriptor with every HANDS
  // message (see HAND_SKINS in src/storage.js); this is only what to draw before
  // one arrives, and it is the artwork every build has shipped with.
  let skin = { file: "hands.webp", aspect: 811 / 1181, seam: 50, off: 0.26 };

  // Only the bottom third of the artwork is ever on screen: the forearms run up
  // out of the viewport, and that hidden length is what a hand travels on. It is
  // also why nothing here needs to be careful about the top edge — there is
  // roughly a screen's worth of arm above it to spend.
  const artHeight = () => Math.min(innerHeight * ART_VH, innerWidth * ART_VW) / 100;

  // Everything a skin changes is a custom property, so switching one is three
  // assignments and no rebuild — the stylesheet itself knows nothing about which
  // pair of hands it is drawing.
  const CSS = `
    .stage {
      --h: min(${ART_VH}vh, ${ART_VW}vw);
      position: absolute; left: 50%; top: calc(${REST_VH}vh - var(--h));
      height: var(--h);
      aspect-ratio: var(--art);
      transform: translate(-50%, -4px);
      animation: breathe 7s ease-in-out infinite;
    }
    .hand {
      position: absolute; inset: 0;
      background: var(--art-url) 0 0 / 100% 100% no-repeat;
      transform: translate3d(var(--x, 0px), var(--y, 0px), 0);
      transition: transform 420ms cubic-bezier(.22, .8, .28, 1);
      will-change: transform;
    }
    .hand.quick { transition-duration: 130ms; }
    .l { clip-path: inset(0 calc(100% - var(--seam)) 0 0); }
    .r { clip-path: inset(0 0 0 var(--seam)); }
    @keyframes breathe {
      0%, 100% { transform: translate(-50%, -4px); }
      50%      { transform: translate(-50%, 6px); }
    }
  `;

  let host = null;
  let stage = null;
  let left = null;
  let right = null;

  function applySkin(next) {
    if (next && next.file) skin = next;
    if (!stage) return;
    stage.style.setProperty("--art", String(skin.aspect));
    stage.style.setProperty("--seam", `${skin.seam}%`);
    stage.style.setProperty("--art-url", `url("${chrome.runtime.getURL("outreach/assets/" + skin.file)}")`);
  }

  function build() {
    host = document.createElement("div");
    host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;"
      + "transform:translateY(-102%);transition:transform 720ms cubic-bezier(.16,1,.3,1)";
    // Open, so the geometry can actually be measured from outside. Hiding the
    // internals would buy nothing: a pair of hands painted over the page is not
    // a secret either way.
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>${CSS}</style>`
      + '<div class="stage"><div class="hand l"></div><div class="hand r"></div></div>';
    stage = shadow.querySelector(".stage");
    left = shadow.querySelector(".l");
    right = shadow.querySelector(".r");
    applySkin(skin);
    // A child of <html>, not <body>: React owns the body's subtree and this has
    // no business being inside it.
    document.documentElement.appendChild(host);
  }

  function show(on, nextSkin) {
    if (on && !host) build();
    if (!host) return;
    applySkin(nextSkin);
    if (!on) {
      host.style.transform = "translateY(-102%)";
      return;
    }
    // Reading layout commits the starting transform, so the slide-in transitions
    // instead of jumping. requestAnimationFrame would be the usual trick, but
    // Chrome stops rAF dead on an occluded window, and a forced layout does not
    // need a frame. (The run also asks Chrome to keep rendering such a window —
    // see keepRendering() in cdp.js — but this must not depend on that holding.)
    void host.offsetHeight;
    host.style.transform = "translateY(0)";
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function place(hand, x, y) {
    hand.style.setProperty("--x", `${Math.round(x)}px`);
    hand.style.setProperty("--y", `${Math.round(y)}px`);
  }

  const lift = (hand) => place(hand, 0, 0);
  const quick = (on) => { left.classList.toggle("quick", on); right.classList.toggle("quick", on); };

  // Where a hand's fingertips sit when it is doing nothing.
  function restingAt(hand) {
    const artWidth = artHeight() * skin.aspect;
    return {
      x: innerWidth / 2 + (hand === left ? -skin.off : skin.off) * artWidth,
      y: innerHeight * (REST_VH / 100),
    };
  }

  // The hand nearest the target travels to it and stays there until the click is
  // really over. The limits keep the fingertips on screen; the arm behind them
  // has far more slack than that.
  function dip(x, y) {
    const hand = x < innerWidth / 2 ? left : right;
    const rest = restingAt(hand);
    place(hand,
      clamp(x - rest.x, -innerWidth * 0.24, innerWidth * 0.24),
      clamp(y - rest.y, -innerHeight * 0.34, innerHeight * 0.42));
    return () => lift(hand);
  }

  // Typing is a single INPUT call for the whole message, so the hands keep
  // tapping, alternating, until the worker says the message is in.
  function flurry() {
    let typing = true;
    quick(true);
    (async () => {
      for (let i = 0; typing; i++) {
        const hand = i % 2 ? right : left;
        place(hand, 0, rand(14, 24));
        await sleep(rand(70, 130));
        // Let go while a tap was in the air: the next click already owns the
        // hands, and lifting now would drag it back out of its reach.
        if (!typing) return;
        lift(hand);
        await sleep(rand(50, 120));
      }
    })();
    return () => { typing = false; lift(left); lift(right); quick(false); };
  }

  function tap(hand) {
    quick(true);
    place(hand, 0, 24);
    return () => { lift(hand); quick(false); };
  }

  function drift() {
    place(left, 0, 8);
    place(right, 0, 8);
    return () => { lift(left); lift(right); };
  }

  const IDLE = () => {};

  // Every touch this extension makes goes through input() in input.js, so that is
  // the only place that has to call in here. Returns the "let go" callback, which
  // the caller runs once the real input has finished — a reach then lasts exactly
  // as long as the click it belongs to.
  function press(op, data) {
    if (!host) return IDLE;
    if (op === "click") return dip(data.x, data.y);
    if (op === "type") return flurry();
    if (op === "key") return tap(right);
    if (op === "wheel") return drift();
    return IDLE;
  }

  S.hands = { show, press };
})();
