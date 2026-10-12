// Does the scroller find Instagram's conversation list, and only that?
//
//   node crm/test/scroll.browser.test.mjs
//
// Loads the REAL crm/content/scroll.js into a REAL headless Chrome. Layout is
// the whole subject here — which element scrolls, how tall it is, what it
// contains — and none of that exists without a renderer, so a fixture in jsdom
// would be a fixture agreeing with itself.
//
// The case worth the trouble is the thread page. It scrolls in two places: the
// list on the left and the conversation being read. The conversation holds a
// link to itself, so "the first link's scroller" can be the message pane — and
// scrolling that finds no new conversations, which reads exactly like an inbox
// that has ended. The pass would then report the whole list as collected at
// whatever had already arrived.

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9428;
const SITE_PORT = 8795;
const HERE = path.dirname(fileURLToPath(import.meta.url));

const results = [];
const check = (name, pass, extra = "") =>
  results.push(`${pass ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rows = (from, count) => Array.from({ length: count }, (_, i) =>
  `<a href="/direct/t/${from + i}/" style="display:block;height:72px">chat ${from + i}</a>`).join("");

// The other shape Instagram draws the list in: no link at all, a role=button box
// about 72px tall with an avatar in it. Verified against the live UI by the send
// half (outreach/src/content/direct.js) — and the shape the CRM's first selector
// missed, which cost a run.
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
const cells = (count) => Array.from({ length: count }, (_, i) =>
  `<div role="button" tabindex="0" style="height:72px;display:flex;align-items:center">
     <img src="${PIXEL}" width="44" height="44"><span>chat ${i}</span></div>`).join("");

/**
 * Instagram's Direct, close enough where it matters: a fixed-height list that
 * scrolls, a nav rail that does not, and — on a thread page — a message pane
 * that scrolls too, placed BEFORE the list so the first link on the page is the
 * pane's own. That order is the trap, so the fixture is built to spring it.
 */
const page = (kind) => `<!doctype html><meta charset=utf-8>
<style>body{margin:0;display:flex;height:100vh;overflow:hidden}
  #rail{width:76px;background:#eee}
  #list{width:350px;height:100vh;overflow-y:auto}
  #pane{flex:1;height:100vh;overflow-y:auto}</style>
<div id=rail>rail</div>
${kind === "thread" ? `<div id=pane><a href="/direct/t/777/">the open conversation</a>
  <div style="height:4000px">messages</div></div>` : ""}
${kind === "bare" ? "<div id=nothing>no conversations here</div>"
    : kind === "plain" ? `<div id=list><div style="height:4000px">something else that scrolls</div></div>`
      : `<div id=list>${kind === "cells" ? cells(40) : rows(1, 40)}</div>`}
<script>
  window.__listener = null;
  window.chrome = { runtime: { onMessage: { addListener: (fn) => { window.__listener = fn } } } };
  window.ask = () => new Promise((resolve) => {
    window.__listener({ type: 'scroll-list' }, {}, resolve);
  });
  // What Instagram does when its list reaches the bottom: another chunk of rows.
  window.append = (from, count) => {
    document.getElementById('list').insertAdjacentHTML('beforeend', ${JSON.stringify("")} +
      Array.from({ length: count }, (_, i) =>
        '<a href="/direct/t/' + (from + i) + '/" style="display:block;height:72px">chat</a>').join(''));
    return 1;
  };
  window.tops = () => ({
    list: document.getElementById('list')?.scrollTop ?? null,
    pane: document.getElementById('pane')?.scrollTop ?? null,
  });
  window.listBox = () => {
    const r = document.getElementById('list')?.getBoundingClientRect();
    return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null;
  };
<\/script>`;

const KINDS = ["thread", "cells", "plain", "bare"];
const site = http.createServer((req, res) => {
  const kind = req.url.includes("/direct/t/") ? "thread"
    : KINDS.find((k) => req.url.includes(k)) ?? "inbox";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page(kind));
});
await new Promise((resolve) => site.listen(SITE_PORT, "127.0.0.1", resolve));

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "siluet-scroll-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`,
  "--no-first-run", "--no-default-browser-check", "--window-size=1280,800", "about:blank",
], { stdio: "ignore" });

async function pageTarget() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const target = list.find((t) => t.type === "page");
      if (target) return target;
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

  const source = fs.readFileSync(path.join(HERE, "..", "content", "scroll.js"), "utf8");
  /** The extension's own script, on a fresh page, exactly as Chrome injects it. */
  async function freshPage(url) {
    await send("Page.navigate", { url: `http://127.0.0.1:${SITE_PORT}${url}` });
    await sleep(300);
    await evaluate(source);
  }

  // ── the inbox ──────────────────────────────────────────────────────────────
  await freshPage("/direct/inbox/");
  const first = await evaluate("ask()", true);
  const tops = await evaluate("tops()");
  check("the list is scrolled to its bottom", first?.ok === true && tops.list > 0,
    JSON.stringify({ ...first, scrollTop: tops.list }));
  check("  and it reports the list it moved, not the document",
    first?.rows === 40 && first.top === tops.list && first.height > first.top,
    JSON.stringify(first));

  // ── a chunk arriving, which is the only reason to scroll again ─────────────
  const before = first?.top ?? 0;
  await evaluate("append(41, 40)");
  const second = await evaluate("ask()", true);
  check("a list that grew is followed further down",
    second?.ok === true && second.top > before && second.rows === 80,
    JSON.stringify({ before, ...second }));

  // ── the thread page, where two things scroll ───────────────────────────────
  await freshPage("/direct/t/777/");
  const onThread = await evaluate("ask()", true);
  const both = await evaluate("tops()");
  check("on a thread page the LIST is scrolled, not the open conversation",
    onThread?.ok === true && both.list > 0 && both.pane === 0,
    JSON.stringify({ ...onThread, ...both }));
  check("  and the conversation's own link is not counted as the list",
    onThread?.rows === 40, JSON.stringify(onThread));

  // The worker aims a real wheel at this point, and a wheel goes to whatever is
  // under the pointer. Off by a column and every tick would scroll the thread.
  const box = await evaluate("listBox()");
  check("  the point the wheel is aimed at is inside the list, not beside it",
    onThread.x > box.left && onThread.x < box.right && onThread.y > box.top && onThread.y < box.bottom,
    JSON.stringify({ x: onThread.x, y: onThread.y, ...box }));

  // ── the list drawn without links, which is what the live inbox does ────────
  await freshPage("/direct/cells/");
  const asCells = await evaluate("ask()", true);
  const cellTops = await evaluate("tops()");
  check("a list of role=button rows with avatars is recognised as the list",
    asCells?.ok === true && asCells.picked === "rows" && asCells.rows === 40 && cellTops.list > 0,
    JSON.stringify({ ...asCells, probe: undefined, scrollTop: cellTops.list }));

  // ── a shape nobody here has seen ───────────────────────────────────────────
  // The guess is allowed, but it has to admit to being one and say what it saw.
  await freshPage("/direct/plain/");
  const guessed = await evaluate("ask()", true);
  check("a page with no row shape at all is still scrolled, as a stated guess",
    guessed?.ok === true && guessed.picked === "tallest" && guessed.rows === 0,
    JSON.stringify({ ok: guessed?.ok, picked: guessed?.picked, rows: guessed?.rows }));
  check("  and it carries out what the page is made of, in counts only",
    guessed?.probe?.path === "/direct/plain/" && Array.isArray(guessed.probe.scrollers)
    && guessed.probe.scrollers.length > 0 && guessed.probe.scrollers[0].h > 0,
    JSON.stringify(guessed?.probe));

  // ── pages that have nothing to give ────────────────────────────────────────
  await freshPage("/empty/");
  check("a page outside Direct is refused before anything is touched",
    (await evaluate("ask()", true))?.error === "not-on-direct");

  await freshPage("/direct/bare/");
  check("Direct with nothing that scrolls says so, and does not invent a list",
    (await evaluate("ask()", true))?.error === "no-list");
} finally {
  if (socket) socket.close();
  chrome.kill();
  // Chrome is still writing its profile as it goes down, and a half-removed temp
  // directory must never be the thing that decides whether the test passed.
  await new Promise((resolve) => chrome.once("exit", resolve));
  site.close();
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* it is a temp dir */ }
}

console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
