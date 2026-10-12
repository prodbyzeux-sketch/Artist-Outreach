// How fast does the CRM learn that its reply actually went?
//
//   node crm/test/compose.browser.test.mjs
//
// Loads the REAL crm/content/compose.js into a REAL headless Chrome, on a page
// served at /direct/t/… so the path check sees what it sees in Instagram, with
// chrome.runtime stubbed so the message handlers can be called directly.
//
// The point of the test is the timers. The linked tab is a BACKGROUND tab, and
// Chrome holds setTimeout in a hidden tab to roughly once a second — much less
// often once it has been hidden a while. A poll therefore reported a send long
// after it had happened. That throttling is what `throttle(on)` imitates here:
// every setTimeout on the page is stretched 30×, so anything that waits by
// polling answers late enough to fail, and only something driven by mutations
// answers on time.

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9426;
const SITE_PORT = 8793;
const HERE = path.dirname(fileURLToPath(import.meta.url));

const results = [];
const check = (name, pass, extra = "") =>
  results.push(`${pass ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Instagram's composer sits inside a container, and that container is what the
// observer has to watch — so the fixture has one too.
const PAGE = `<!doctype html><meta charset=utf-8>
<div id=footer>
  <div id=box contenteditable="true" role="textbox" style="min-height:40px;border:1px solid #999"></div>
</div>
<script>
  window.__listener = null;
  window.chrome = { runtime: { onMessage: { addListener: (fn) => { window.__listener = fn } } } };

  // Chrome's background-tab timer throttling, close enough to hurt: a 100ms poll
  // becomes a 3s one.
  const nativeSetTimeout = window.setTimeout.bind(window);
  window.throttle = (on) => {
    window.setTimeout = on
      ? (fn, ms = 0, ...rest) => nativeSetTimeout(fn, Math.max(ms, 1) * 30, ...rest)
      : nativeSetTimeout;
  };

  window.ask = (type) => new Promise((resolve) => {
    window.__listener({ type }, {}, (result) => resolve({ ...result, at: performance.now() }));
  });
  window.fill = (text) => { document.getElementById('box').textContent = text; return 1 };
  window.clearBox = () => {
    document.getElementById('box').textContent = '';
    window.clearedAt = performance.now();
    return 1;
  };
<\/script>`;

const site = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
});
await new Promise((resolve) => site.listen(SITE_PORT, "127.0.0.1", resolve));

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "siluet-compose-"));
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

  const evaluate = async (expression, awaitPromise = false) =>
    (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise })).result.value;

  const composeSource = fs.readFileSync(path.join(HERE, "..", "content", "compose.js"), "utf8");
  /** The extension's own script, on a fresh page, exactly as Chrome injects it. */
  async function freshPage() {
    await send("Page.navigate", { url: `http://127.0.0.1:${SITE_PORT}/direct/t/1234/` });
    await sleep(300);
    await evaluate(composeSource);
  }

  // ── the path check, which is the one thing the fixture's URL is for ────────
  await freshPage();
  check("the composer is found and focused on a thread page",
    (await evaluate("ask('focus-composer')", true))?.ok === true);

  // ── a thread that is still rendering ──────────────────────────────────────
  // The linked tab navigates to the conversation and the composer arrives a beat
  // later; waiting for it used to be polled too.
  await freshPage();
  await evaluate("throttle(true)");
  await evaluate("document.getElementById('footer').innerHTML = ''");
  await evaluate("window.__pending = ask('focus-composer'); 1");
  await sleep(250);
  await evaluate(`(() => {
    const box = document.createElement('div');
    box.id = 'box';
    box.contentEditable = 'true';
    box.setAttribute('role', 'textbox');
    document.getElementById('footer').append(box);
    window.appearedAt = performance.now();
    return 1;
  })()`);
  const appeared = await evaluate("__pending.then((r) => ({ ...r, delta: r.at - window.appearedAt }))", true);
  check("a composer that renders late is taken the moment it renders",
    appeared?.ok === true && appeared.delta < 500, `${Math.round(appeared?.delta ?? -1)}ms after it appeared`);
  await evaluate("throttle(false)");

  // ── an answer that is already true costs nothing ───────────────────────────
  await freshPage();
  const immediate = await evaluate("ask('confirm-sent')", true);
  check("an already-empty composer confirms at once", immediate?.ok === true, JSON.stringify(immediate));

  // ── the regression: a throttled tab must not delay the answer ──────────────
  await freshPage();
  await evaluate("throttle(true)");
  await evaluate("fill('привет, свёл бы трек')");
  await evaluate("window.__pending = ask('confirm-sent'); 1");
  await sleep(250);
  await evaluate("clearBox()");
  const late = await evaluate("__pending.then((r) => ({ ...r, delta: r.at - window.clearedAt }))", true);

  check("a send is confirmed when it happens, not when a throttled timer wakes up",
    late?.ok === true && late.delta < 500, `${Math.round(late?.delta ?? -1)}ms after the composer emptied`);
  await evaluate("throttle(false)");

  // ── and a send that never went still fails, on its own clock ───────────────
  await freshPage();
  await evaluate("fill('это никуда не уйдёт')");
  const started = Date.now();
  const stuck = await evaluate("ask('confirm-sent')", true);
  const waited = Date.now() - started;
  check("a composer that never empties reports not-sent",
    stuck?.ok === false && stuck.error === "not-sent", JSON.stringify(stuck));
  check("  after the 4s it promises, not sooner", waited >= 3800 && waited < 6000, `${waited}ms`);
} finally {
  if (socket) socket.close();
  chrome.kill();
  site.close();
  // Chrome is still flushing its profile as it goes down.
  fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

console.log(results.join("\n"));
const ok = results.every((r) => r.startsWith("PASS"));
console.log(ok ? "ALL PASS" : "SOME FAILED");
process.exit(ok ? 0 : 1);
