// Does a field end up holding EXACTLY what was typed into it?
//
//   node test/typing.test.mjs
//
// Drives the REAL src/cdp.js against a REAL headless Chrome — chrome.debugger is
// stubbed to forward every command down a DevTools socket, so the keystrokes
// under test are the ones a run sends, interpreted by the same engine Instagram
// runs in. Nothing here mocks a field.
//
// It exists because of a lead's search box that ended up holding one handle
// twice over ("…basso" + "beatrcce__basso"). The cause is one line: on macOS,
// select-all is an editing command the OS derives from Cmd+A and hands to the
// renderer, and CDP injects BELOW that translation — so the modifier alone
// selected nothing and the Backspace after it ate a single character. Every
// "clear, then type" therefore appended. The clear now carries the command with
// the keystroke, and these checks hold it to that.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9422;
const HANDLE = "beatrcce__basso";
const MESSAGE = "привет 👋 слушай, а ты beats продаёшь?";

const results = [];
const check = (name, pass, extra = "") =>
  results.push(`${pass ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The worker runs inside Chrome, so cdp.js reads the platform off navigator —
// and the platform is the whole point here. Say Mac, and test the Mac path.
Object.defineProperty(globalThis, "navigator", {
  value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" }, configurable: true,
});

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "siluet-typing-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`,
  "--no-first-run", "--no-default-browser-check", "about:blank",
], { stdio: "ignore" });

// ── the socket, and the chrome.debugger stub that speaks through it ───────────
async function pageTarget() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch (_e) { /* the port isn't up yet */ }
    await sleep(200);
  }
  throw new Error(`Chrome never opened a debugging port on ${PORT}`);
}

let socket = null;
let nextId = 0;
const pending = new Map();

const send = (method, params = {}) => new Promise((resolve, reject) => {
  pending.set(++nextId, { resolve, reject });
  socket.send(JSON.stringify({ id: nextId, method, params }));
});

try {
  const target = await pageTarget();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (!m.id || !pending.has(m.id)) return;
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  };

  globalThis.chrome = {
    debugger: {
      attach: async () => {},
      detach: async () => {},
      sendCommand: (_target, method, params) => send(method, params),
      onDetach: { addListener: () => {} },
      onEvent: { addListener: () => {} },
    },
  };
  const cdp = await import("../src/cdp.js");
  await cdp.attach(1, "typing-test");

  const evaluate = async (expression) =>
    (await send("Runtime.evaluate", { expression, returnByValue: true })).result.value;

  // A React-controlled input and a contenteditable: Direct's search box is the
  // first, every composer in this extension is the second.
  const PAGE = "<!doctype html><meta charset=utf-8>"
    + '<input id=q style="width:420px;font-size:18px">'
    + '<div id=box contenteditable style="width:420px;min-height:40px;font-size:18px;border:1px solid #999"></div>';
  await send("Page.navigate", { url: `data:text/html,${encodeURIComponent(PAGE)}` });
  await sleep(400);

  const focus = (sel) => evaluate(`(() => { document.querySelector('${sel}').focus(); return 1 })()`);
  // The same reading src/content/input.js does when it checks its own typing —
  // rendered text, so a <br> counts as the line break it looks like.
  const read = (sel) => evaluate(
    `(() => { const el = document.querySelector('${sel}'); return el.value ?? el.innerText })()`);

  // ── an ordinary input ──────────────────────────────────────────────────────
  await focus("#q");
  await cdp.typeText(HANDLE, 4);
  check("a handle types into an input exactly", await read("#q") === HANDLE, await read("#q"));

  // The regression: this is the step that quietly did nothing. "Empty" is read
  // the way fillField reads it — a cleared contenteditable keeps the <br> Chrome
  // parks in it, which is whitespace and nothing else.
  const blank = (s) => /^\s*$/.test(s);
  await cdp.clearField();
  check("  clearField empties it", blank(await read("#q")), JSON.stringify(await read("#q")));

  // …and the shape the user actually saw — the same handle typed for a second
  // lead landing on top of the first, in one box.
  await cdp.typeText(HANDLE, 4);
  await cdp.clearField();
  await cdp.typeText(HANDLE, 4);
  check("  typing again after a clear replaces, never appends",
    await read("#q") === HANDLE, await read("#q"));

  // ── a contenteditable, which is what every message is typed into ───────────
  await focus("#box");
  await cdp.typeText(MESSAGE, 4);
  check("a message types into a contenteditable exactly",
    await read("#box") === MESSAGE, await read("#box"));
  await cdp.clearField();
  check("  clearField empties that too", blank(await read("#box")), JSON.stringify(await read("#box")));

  // A newline is a soft break — it must not submit, must not vanish, and must
  // still read back as a break, or a two-line message never matches itself and
  // every send with one in it is refused.
  await cdp.typeText("first\nsecond", 4);
  check("  a line break lands as a break and reads back as one",
    /^first\s*\n\s*second$/.test(await read("#box")), JSON.stringify(await read("#box")));
} finally {
  if (socket) socket.close();
  chrome.kill();
  // Chrome is still flushing its profile as it goes down.
  fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

console.log(results.join("\n"));
const ok = results.every((r) => r.startsWith("PASS"));
console.log(ok ? "ALL PASS" : "SOME FAILED");
process.exit(ok ? 0 : 1);
