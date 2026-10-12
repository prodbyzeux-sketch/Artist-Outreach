// Does a CRM reply reach the page as REAL input — the kind a composer submits on?
//
//   node crm/test/trusted-input.browser.test.mjs
//
// Drives the REAL crm/trusted-input.js against a REAL headless Chrome, the same
// way outreach/test/typing.test.mjs drives the send run's driver: chrome.debugger
// is stubbed to forward every command down a DevTools socket, so the keystrokes
// under test are the ones the extension sends, interpreted by the engine
// Instagram runs in.
//
// It exists because of the bug it is named after: a reply written in the CRM was
// typed into Instagram's composer and then just sat there. A KeyboardEvent
// dispatched from a content script is untrusted — listeners see it, but Blink
// runs no editing command, and a Lexical composer submits on the command, not on
// the key. The page below stands in for that composer: it clears itself when the
// browser asks to insert a paragraph, which is exactly the signal
// crm/content/compose.js waits for. Both paths are run against it — the old one
// to hold the regression down, the new one to show it sends.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9424;
const MESSAGE = "привет 👋 свёл бы трек, скину примеры";

const results = [];
const check = (name, pass, extra = "") =>
  results.push(`${pass ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "siluet-trusted-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`,
  "--no-first-run", "--no-default-browser-check", "about:blank",
], { stdio: "ignore" });

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

// A composer that submits on Enter: it clears itself the moment the browser asks
// for a paragraph, and records what it was asked for.
const PAGE = `<!doctype html><meta charset=utf-8>
<div id=box contenteditable role=textbox style="width:420px;min-height:40px;border:1px solid #999"></div>
<script>
  const box = document.getElementById('box');
  window.trace = [];
  window.sent = false;
  box.addEventListener('keydown', (e) => window.trace.push('keydown:' + e.key + ':trusted=' + e.isTrusted));
  box.addEventListener('beforeinput', (e) => {
    window.trace.push('beforeinput:' + e.inputType);
    if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') {
      e.preventDefault();
      box.textContent = '';
      window.sent = true;
    }
  });
<\/script>`;

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
    },
  };
  const { insertAndSend } = await import("../trusted-input.js");

  const evaluate = async (expression) =>
    (await send("Runtime.evaluate", { expression, returnByValue: true })).result.value;

  await send("Page.navigate", { url: `data:text/html,${encodeURIComponent(PAGE)}` });
  await sleep(400);

  const reset = () => evaluate(
    "(() => { const b = document.getElementById('box'); b.textContent=''; window.trace=[]; window.sent=false; b.focus(); return 1 })()");
  const read = () => evaluate("document.getElementById('box').innerText");
  const trace = () => evaluate("window.trace.join(' | ')");
  const sent = () => evaluate("window.sent");

  // ── the old path, kept as the regression ──────────────────────────────────
  // Exactly what crm/content/compose.js used to do, run from inside the page.
  await reset();
  await evaluate(`(() => {
    const box = document.getElementById('box');
    box.focus();
    document.execCommand('insertText', false, ${JSON.stringify(MESSAGE)});
    for (const type of ['keydown', 'keypress', 'keyup']) {
      box.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
    return 1;
  })()`);
  check("a synthetic Enter types the message and never sends it",
    (await sent()) === false && (await read()).includes("свёл бы трек"), await trace());

  // ── the path the CRM takes now ────────────────────────────────────────────
  await reset();
  const result = await insertAndSend(1, MESSAGE);
  await sleep(200);

  check("insertAndSend reports success", result.ok === true, JSON.stringify(result));
  check("  the message reaches the composer", (await trace()).includes("beforeinput:insertText"), await trace());
  check("  Enter arrives as trusted input", (await trace()).includes("keydown:Enter:trusted=true"), await trace());
  // The whole fix in one line: the browser runs the editing command, which is
  // what a Lexical composer submits on.
  check("  it submits", (await sent()) === true, await trace());
  check("  and the box is left empty, which is how compose.js confirms the send",
    /^\s*$/.test(await read()), JSON.stringify(await read()));
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
