// Does fillField put the message in, whatever KIND of field it is?
//
//   node test/fill-field.test.mjs
//
// The real content layer (dom → hands → input) in a real headless Chrome, with
// its INPUT messages routed to the real src/cdp.js — the same round trip a run
// makes, page → worker → keystrokes, minus Instagram. typing.test.mjs holds
// cdp.js on its own; this holds the layer that decides WHAT to type.
//
// It exists because of a lead that was dropped without a word going out. The
// message had a line break in it; the share sheet's "Write a message…" is a
// single-line <input>, and a break typed into one of those (Shift+Enter) lands
// as no character at all. So the field read back "…heavy asfI am music…", never
// matched the message, and every attempt failed identically — three of them,
// twice over, and the lead was marked failed. A one-line field now gets the
// message with its breaks as spaces, which is the only thing it can hold.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9423;
const ROOT = path.dirname(new URL(import.meta.url).pathname);

// The message from the run that failed, breaks and all.
const MESSAGE = "hey you sound heavy asf\nI am music producer and i wanna send you smth";

const results = [];
const check = (name, pass, extra = "") =>
  results.push(`${pass ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// cdp.js reads the platform off navigator, and the clear depends on it.
Object.defineProperty(globalThis, "navigator", {
  value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" }, configurable: true,
});

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "siluet-fill-"));
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
let onBinding = () => {};

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
    if (m.method === "Runtime.bindingCalled") return onBinding(JSON.parse(m.params.payload));
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
  await cdp.attach(1, "fill-field-test");
  // The same switch a run throws, and for the same reason. Nothing is looking at
  // this page, so Chrome produces no frames for it — and a mouse event is only
  // ACKed once one is produced, so a click waits for a frame that never comes.
  // Measured here: 145 SECONDS for one click without this, 0.7s with it.
  await cdp.keepRendering();

  const evaluate = async (expression, awaitPromise = false) => {
    const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
    if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
    return res.result.value;
  };

  // Direct's search box and the share sheet's message box are inputs; the story
  // reply box is a textarea.
  const PAGE = "<!doctype html><meta charset=utf-8>"
    + '<style>*{font-size:18px}#q,#t{display:block;width:600px;margin:8px}</style>'
    + '<input id=q>'
    + '<textarea id=t rows=3></textarea>';
  await send("Page.navigate", { url: `data:text/html,${encodeURIComponent(PAGE)}` });
  await sleep(400);

  // The page's half of the round trip: the content layer's INPUT messages come
  // out through a binding, get performed by the real cdp.js, and the answer goes
  // back into the promise the layer is awaiting.
  await send("Runtime.enable");
  await send("Runtime.addBinding", { name: "__toWorker" });
  await evaluate(`
    globalThis.__pending = {};
    globalThis.__n = 0;
    globalThis.__settle = (id, res) => { const r = __pending[id]; delete __pending[id]; r(res); };
    globalThis.__steps = [];
    globalThis.chrome = {
      runtime: {
        getURL: (p) => "/" + p,
        sendMessage: (m) => {
          if (m.type === "STEP") { __steps.push(m.text); return Promise.resolve({ ok: true }); }
          if (m.type !== "INPUT") return Promise.resolve({ ok: true });
          const id = ++__n;
          return new Promise((resolve) => {
            __pending[id] = resolve;
            __toWorker(JSON.stringify({ id, msg: m }));
          });
        },
      },
    };
  `);

  onBinding = ({ id, msg }) => {
    const done = (ok, error) =>
      evaluate(`__settle(${id}, ${JSON.stringify(ok ? { ok: true } : { ok: false, error })})`);
    (async () => {
      switch (msg.op) {
        case "click": return cdp.click(msg.x, msg.y);
        case "move": return cdp.moveTo(msg.x, msg.y);
        case "type": return cdp.typeText(msg.text, msg.speed);
        case "clear": return cdp.clearField();
        case "wheel": return cdp.wheel(msg.dy);
        case "key": return msg.key === "Enter" ? cdp.pressEnter() : cdp.pressEscape();
        default: throw new Error(`unknown input op: ${msg.op}`);
      }
    })().then(() => done(true), (e) => done(false, String(e.message || e)));
  };

  // The real layer, in the order manifest.json declares it.
  for (const file of ["dom.js", "hands.js", "input.js"]) {
    await evaluate(fs.readFileSync(path.join(ROOT, "..", "src", "content", file), "utf8"));
  }

  const fill = (selector, text) => evaluate(
    `window.__igs.fillField(() => document.querySelector(${JSON.stringify(selector)}),`
    + ` ${JSON.stringify(text)}, 4)`, true);
  const read = (selector) => evaluate(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el.value ?? el.innerText })()`);
  const steps = () => evaluate("__steps.join(' | ')");

  // ── a one-line input: what the run actually failed on ──────────────────────
  const inputProblem = await fill("#q", MESSAGE);
  check("a message with a break goes into a one-line input", inputProblem === null, inputProblem || "");
  check("  …with the break as a space, and nothing else changed",
    await read("#q") === MESSAGE.replace("\n", " "), JSON.stringify(await read("#q")));
  check("  …and the log says so", /one line/.test(await steps()), await steps());

  // ── a field that CAN hold a break must keep it ─────────────────────────────
  // The story reply box is a textarea; the contenteditable composers are held to
  // the same thing one layer down, in test/typing.test.mjs.
  const areaProblem = await fill("#t", MESSAGE);
  check("a textarea keeps the break", areaProblem === null && await read("#t") === MESSAGE,
    areaProblem || JSON.stringify(await read("#t")));

  // ── the ordinary case, and the one fillField exists for ────────────────────
  const HANDLE = "takesavillagemusic";
  const handleProblem = await fill("#q", HANDLE);
  check("a handle still types into the search box exactly",
    handleProblem === null && await read("#q") === HANDLE,
    handleProblem || JSON.stringify(await read("#q")));

  const again = await fill("#q", "beatrcce__basso");
  check("  a second fill replaces it, never appends",
    again === null && await read("#q") === "beatrcce__basso",
    again || JSON.stringify(await read("#q")));

  // A field that cannot hold the text must still be reported, not waved through:
  // maxlength truncates, which is exactly what a silent success would hide.
  await evaluate(`document.querySelector('#q').maxLength = 8`);
  const truncated = await fill("#q", HANDLE);
  check("a field that truncates is reported, not accepted",
    typeof truncated === "string" && truncated.includes("couldn't type"), String(truncated));
} finally {
  if (socket) socket.close();
  chrome.kill();
  fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

console.log(results.join("\n"));
const ok = results.every((r) => r.startsWith("PASS"));
console.log(ok ? "ALL PASS" : "SOME FAILED");
process.exit(ok ? 0 : 1);
