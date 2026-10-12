// cdp.js — the hands. Every click and keystroke goes through chrome.debugger
// (CDP Input domain), so the page receives REAL browser input events
// (isTrusted === true) instead of synthetic ones dispatched from a script.
//
// Attaching shows Chrome's "extension is debugging this browser" bar on the
// work window. That is the price of trusted input; it can only be silenced
// globally, by starting Chrome with --silent-debugger-extension-api.
//
// The keyboard sequence is ported from Tabels' typeOneChar, including two
// findings that cost a long time there:
//   · a keyDown carrying `text` ALREADY inserts the glyph and fires keypress —
//     sending a separate `char` event types everything twice;
//   · only letters, digits and space may be sent as real keystrokes. Every
//     other printable ASCII code point collides with a navigation/editing
//     virtual key ('.' = VK_DELETE, '#' = VK_END, '\'' = VK_RIGHT …) and Chrome
//     runs that command around the insert, swallowing the character or
//     teleporting the caret. Those go through Input.insertText instead.

import { makeProfile, baseCharDelayMs, arcMultiplier, typoMultiplier, dayPartMultiplier, mousePath }
  from "./human.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ── attachment ────────────────────────────────────────────────────────────────
let attachedTabId = null;
let profile = null;
let cursor = null;       // where the pointer currently is, in CSS px
let sentInSession = 0;   // drives the warm-up / fatigue pacing
let onLost = null;       // told when Chrome takes the session away

const cmd = (method, params) => {
  if (attachedTabId == null) throw new Error("the input driver is detached");
  return chrome.debugger.sendCommand({ tabId: attachedTabId }, method, params);
};

// Chrome hands the debugging session back on its own — Cancel on the debugging
// bar, DevTools opening on the work tab, the tab closing or crashing. Every
// command after that fails, so the run has to hear about it ONCE; without this
// it would find out lead by lead and burn the whole queue into `failed`.
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId !== attachedTabId) return;
  attachedTabId = null;
  if (onLost) onLost(reason);
});

// The orchestrator's hook for that. Our own detach() clears attachedTabId
// first, so a planned teardown never reaches it.
export const onDriverLost = (fn) => { onLost = fn; };

// ── reading the inbox, without asking for it ──────────────────────────────────
// The work window is standing in Direct anyway, so Instagram fetches its own
// inbox payloads. We record those responses instead of making requests of our
// own — the same rule the input layer follows. Bodies go to src/inbox.js.
let onTraffic = null;
const graphqlStatus = new Map();   // requestId → HTTP status, until the body lands

export const onInboxTraffic = (fn) => { onTraffic = fn; };

// ── taking one picture the page loads ─────────────────────────────────────────
// Same idea as the inbox, one domain lower down. The avatar lives on Instagram's
// CDN, which is a different origin from instagram.com, so the page's own request
// for it comes back OPAQUE: the renderer never holds those bytes, and
// Network.getResponseBody answers "No data found for resource" — measured, along
// with everything else here, in test/avatar-capture.test.mjs. Intercepting the
// response instead catches it before opacity is applied, and that returns the
// bytes exactly.
//
// It still matters that the PAGE asks (PULL, in src/content/main.js): Instagram's
// CDN is then answering Instagram, with its cookies and its referrer, for a
// picture it just showed. A request of our own would carry a chrome-extension://
// origin, which the CDN is entitled to refuse and which costs host permissions
// for two more domains to even try.
//
// Two steps on purpose. armCapture() has to be awaited on its own — the
// interception must be standing before the page is told to load anything — and
// an async function that returned the body's promise would be awaited as the
// BODY, which deadlocks: nobody would ever send the page its instruction.
let capture = null;   // { url, resolve, promise, live }

// CDP url patterns take * and ? as wildcards, and a signed CDN URL is full of ?.
const escapePattern = (url) => url.replace(/[\\*?]/g, (c) => `\\${c}`);

function settle(got) {
  const mine = capture;
  mine.live = false;
  cmd("Fetch.disable", {}).catch(() => {});   // the session may already be gone
  mine.resolve(got);
}

export async function armCapture(url, timeoutMs = 15000) {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  capture = { url, resolve, promise, live: true };
  const mine = capture;
  setTimeout(() => { if (mine.live) settle(null); }, timeoutMs);
  await cmd("Fetch.enable", { patterns: [{ urlPattern: escapePattern(url), requestStage: "Response" }] });
}

// The bytes armCapture() went looking for, or null. Safe to ask for after they
// have already landed — the answer outlives the capture.
export const captured = () => (capture ? capture.promise : Promise.resolve(null));

function takeBody(requestId, headers) {
  const mine = capture;
  const type = (headers || []).find((h) => h.name.toLowerCase() === "content-type");
  cmd("Fetch.getResponseBody", { requestId })
    .then((r) => (r && r.body && r.base64Encoded
      ? { base64: r.body, mimeType: (type && type.value) || "" }
      : null))
    .catch(() => null)
    .then((got) => {
      // Always let it through: a paused request nobody continues is a picture
      // the page is still waiting for.
      cmd("Fetch.continueRequest", { requestId }).catch(() => {});
      if (mine.live) settle(got);
    });
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== attachedTabId || !params) return;
  if (method === "Network.responseReceived") {
    const url = params.response?.url || "";
    if (url.includes("/api/graphql")) graphqlStatus.set(params.requestId, params.response.status);
  } else if (method === "Network.loadingFinished" && onTraffic && graphqlStatus.has(params.requestId)) {
    const status = graphqlStatus.get(params.requestId);
    graphqlStatus.delete(params.requestId);
    // Bodies are evicted quickly, so pull as soon as the load finishes.
    cmd("Network.getResponseBody", { requestId: params.requestId })
      .then((r) => onTraffic(r && r.body ? r.body : "", status))
      .catch(() => {});   // evicted or the session went away — nothing to do
  } else if (method === "Fetch.requestPaused") {
    if (capture && capture.live && params.request?.url === capture.url) {
      takeBody(params.requestId, params.responseHeaders);
    } else {
      cmd("Fetch.continueRequest", { requestId: params.requestId }).catch(() => {});
    }
  }
});

export async function attach(tabId, seed) {
  if (attachedTabId === tabId) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  attachedTabId = tabId;
  graphqlStatus.clear();
  await cmd("Network.enable", {});   // for the inbox capture above
  profile = makeProfile(seed);
  // The pointer starts wherever the last person left it, not at (0,0).
  cursor = { x: rand(120, 700), y: rand(120, 500) };
}

export async function detach() {
  if (attachedTabId == null) return;
  const tabId = attachedTabId;
  attachedTabId = null;
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

export const isAttached = () => attachedTabId != null;
export const setSentInSession = (n) => { sentInSession = n; };
export const currentProfile = () => profile;

// Keep the work window working when it is out of sight.
//
// A window on another macOS Space — or one fully covered by another window — is
// occluded, and Chrome stops producing frames for it. The renderer's whole
// rendering step goes with them: requestAnimationFrame, IntersectionObserver,
// ResizeObserver and CSS transitions all stop, and the page's timers drop to a
// wake a second. Instagram builds its lists and threads on exactly those, so the
// run stands still until somebody looks at the window again.
//
// Focus emulation is the switch that turns it back on from here: the renderer
// treats the page as focused AND active, and reports visibilityState "visible".
// Measured on a window fully covered by another: 0 frames and 1000ms timers
// before, 354 frames in 6s and 251ms timers after. It survives a navigation, and
// turning it off puts the window straight back to 0 frames — so the effect is
// this and nothing about the window.
//
// It also makes the page think it has keyboard focus, which is what an
// automation typing into a composer wants anyway.
export const keepRendering = () => cmd("Emulation.setFocusEmulationEnabled", { enabled: true });

// What the settings slider calls 1× — everything the hands do (typing, cursor
// travel, click dwell) is this much faster than the raw profile numbers.
const BASE_SPEED = 1.7;

const paceMultiplier = () => arcMultiplier(sentInSession) * dayPartMultiplier(profile) / BASE_SPEED;

// ── mouse ─────────────────────────────────────────────────────────────────────
export async function moveTo(x, y) {
  const target = { x, y };
  for (const p of mousePath(cursor, target, profile, paceMultiplier())) {
    await cmd("Input.dispatchMouseEvent", {
      type: "mouseMoved", x: Math.round(p.x), y: Math.round(p.y), button: "none", buttons: 0,
    });
    await sleep(p.dt);
  }
  cursor = target;
}

export async function click(x, y) {
  await moveTo(x, y);
  await sleep(rand(40, 140)); // the hand stops before it presses
  const common = { x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 };
  await cmd("Input.dispatchMouseEvent", { ...common, type: "mousePressed", buttons: 1 });
  const [lo, hi] = profile.holdMs;
  await sleep(Math.max(40, rand(lo, hi) * paceMultiplier()));
  await cmd("Input.dispatchMouseEvent", { ...common, type: "mouseReleased", buttons: 0 });
}

// A wheel scroll broken into a few decelerating ticks — one giant delta is not
// something a wheel or a trackpad can produce.
export async function wheel(deltaY) {
  const ticks = Math.max(2, Math.min(6, Math.round(Math.abs(deltaY) / 110)));
  let left = deltaY;
  for (let i = ticks; i >= 1; i--) {
    const chunk = i === 1 ? left : Math.round((left / i) * rand(0.8, 1.25));
    left -= chunk;
    await cmd("Input.dispatchMouseEvent", {
      type: "mouseWheel", x: Math.round(cursor.x), y: Math.round(cursor.y),
      deltaX: 0, deltaY: chunk, pointerType: "mouse",
    });
    await sleep(rand(30, 90));
  }
}

// ── keyboard ──────────────────────────────────────────────────────────────────
// `code` + Windows virtual-key code for one printable ASCII char. An empty code
// means "do not send this as a keystroke" — see the header note.
function keyDescriptor(ch) {
  if (ch.charCodeAt(0) > 127) return null;
  const upper = ch.toUpperCase();
  const c = upper.charCodeAt(0);
  if (c >= 65 && c <= 90) return { code: `Key${upper}`, vk: c };
  if (c >= 48 && c <= 57) return { code: `Digit${upper}`, vk: c };
  if (ch === " ") return { code: "Space", vk: 32 };
  return null;
}

async function typeChar(ch) {
  const key = keyDescriptor(ch);
  if (!key) {
    // Punctuation, emoji, Cyrillic — insert the text, wrapped in a keypress
    // cycle so page listeners still see one press per character.
    await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "Unidentified", code: "", windowsVirtualKeyCode: 0 });
    await cmd("Input.insertText", { text: ch });
    await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "Unidentified", code: "", windowsVirtualKeyCode: 0 });
    return;
  }
  await cmd("Input.dispatchKeyEvent", {
    type: "keyDown", key: ch, code: key.code,
    windowsVirtualKeyCode: key.vk, nativeVirtualKeyCode: key.vk,
    text: ch, unmodifiedText: ch,
  });
  await cmd("Input.dispatchKeyEvent", {
    type: "keyUp", key: ch, code: key.code, windowsVirtualKeyCode: key.vk,
  });
}

// `commands` rides on the keyDown only — it is the editing command the keystroke
// stands for, not part of the keystroke.
async function specialKey({ key, code, vk, text = "", modifiers = 0, commands }) {
  await cmd("Input.dispatchKeyEvent", {
    type: "keyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text,
    unmodifiedText: text, modifiers, ...(commands ? { commands } : {}),
  });
  await cmd("Input.dispatchKeyEvent", {
    type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers,
  });
}

export const pressEnter = () =>
  specialKey({ key: "Enter", code: "Enter", vk: 13, text: "\r" });

export const pressEscape = () =>
  specialKey({ key: "Escape", code: "Escape", vk: 27 });

// Select-all, then delete. Counting backspaces would be wrong — after a React
// re-render the caret is not necessarily at the end of the text.
//
// `commands` is not decoration. On macOS select-all is an EDITING COMMAND the OS
// derives from the keystroke and hands to the renderer, and CDP injects below
// that translation — so the modifier alone selects NOTHING and the Backspace
// then eats a single character. Measured on real Chrome, headless and headful:
// after Cmd+A the selection stayed 8-8 on an eight-character field, and clearing
// "beatrcce" left "beatrcc". Every clear therefore appended instead of
// replacing, which is how one handle went into the search box twice over as
// "…basso" + "beatrcce__basso". With commands: ["selectAll"] the same keystroke
// selects 0-8 and the field ends up empty. Sent on every platform: it is the
// same command Blink runs for Ctrl+A itself, so it costs nothing where the
// keystroke already worked.
const SELECT_ALL_MODIFIER = navigator.userAgent.includes("Mac") ? 4 : 2; // Meta : Ctrl
export async function clearField() {
  await specialKey({
    key: "a", code: "KeyA", vk: 65, modifiers: SELECT_ALL_MODIFIER, commands: ["selectAll"],
  });
  await sleep(rand(60, 160));
  await specialKey({ key: "Backspace", code: "Backspace", vk: 8 });
  await sleep(rand(80, 200));
}

// Soft line break in a composer that has more than one line. Shift is genuinely
// held, so a composer will not send on it; the Enter keyDown must carry text
// "\r" or Lexical inserts no break at all. A single-line <input> is a different
// story — measured on real Chrome, the break lands as no character there and,
// inside a <form>, the keystroke submits — so fillField never sends a break into
// one (src/content/input.js).
async function shiftEnter() {
  await cmd("Input.dispatchKeyEvent", {
    type: "keyDown", key: "Shift", code: "ShiftLeft",
    windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16, modifiers: 8,
  });
  await specialKey({ key: "Enter", code: "Enter", vk: 13, text: "\r", modifiers: 8 });
  await cmd("Input.dispatchKeyEvent", {
    type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16,
  });
}

// QWERTY neighbours, for typos that look like a real slip of the finger.
const NEIGHBORS = {
  a: "sq", b: "vn", c: "xv", d: "sf", e: "wr", f: "dg", g: "fh", h: "gj",
  i: "uo", j: "hk", k: "jl", l: "k", m: "n", n: "bm", o: "ip", p: "o",
  q: "wa", r: "et", s: "ad", t: "ry", u: "yi", v: "cb", w: "qe", x: "zc",
  y: "tu", z: "x",
};

// Types into whatever currently has focus — the caller clicks the field first,
// the way a person does.
export async function typeText(text, typingSpeed = 1) {
  const speedMult = paceMultiplier() / clamp(typingSpeed, 0.3, 4);
  const typoRate = profile.typoRate * typoMultiplier(sentInSession);
  const baseCharMs = baseCharDelayMs(profile);
  // Pasted templates carry CR, U+2028 and U+2029; typed literally they show up
  // as stray glyphs, so fold them all to "\n" first.
  const clean = text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(/\n{3,}/g, "\n\n");

  let prev = "";
  for (const ch of clean) {
    if (ch === "\n") {
      await shiftEnter();
      await sleep((baseCharMs + profile.wordPauseMs) * speedMult);
      prev = ch;
      continue;
    }
    const neighbours = NEIGHBORS[ch.toLowerCase()];
    if (neighbours && Math.random() < typoRate) {
      const slip = neighbours[Math.floor(Math.random() * neighbours.length)];
      await typeChar(ch === ch.toUpperCase() ? slip.toUpperCase() : slip);
      await sleep(rand(150, 400) * speedMult);   // …notices it
      await specialKey({ key: "Backspace", code: "Backspace", vk: 8 });
      await sleep(rand(80, 200) * speedMult);
    }
    await typeChar(ch);

    let dwell = baseCharMs * speedMult + rand(0, baseCharMs * 0.8) * speedMult;
    if (ch === " " || prev === " ") dwell += profile.wordPauseMs * speedMult;
    if (".!?".includes(prev)) dwell += profile.sentencePauseMs * speedMult;
    if (Math.random() < profile.thinkPauseRate) dwell += rand(400, 900) * speedMult;
    await sleep(dwell);
    prev = ch;
  }
}
