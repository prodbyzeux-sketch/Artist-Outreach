// Can the debugger read bytes the PAGE is not allowed to read?
//
//   node test/avatar-capture.test.mjs
//
// The avatar is kept by asking Instagram's own page to load the picture and
// reading the response off the wire (PULL in src/content/main.js → armCapture in
// src/cdp.js). Two things about that are easy to get wrong, and both fail
// silently in exactly the way the bug did, so both are held here against a real
// Chrome and two real origins — 127.0.0.1 serves the page, localhost serves the
// picture, and the picture is served with no CORS header at all:
//
//   · The avatar is cross-origin, so the page's response is OPAQUE. The renderer
//     never holds those bytes and Network.getResponseBody — the way the inbox is
//     read — answers "No data found for resource". Fetch interception at the
//     response stage catches them before opacity is applied.
//   · An opaque response nobody reads is CANCELLED, and then there is nothing to
//     intercept either. The page has to drain it, which hands the page an empty
//     buffer and downloads the whole thing.

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CDP_PORT = 9451;
const WEB_PORT = 9452;
const PAGE = `http://127.0.0.1:${WEB_PORT}/page.html`;
const PIC = `http://localhost:${WEB_PORT}/pic.jpg`;   // a different origin on purpose

// Not a real JPEG: nothing decodes it, and the bytes only have to survive the
// round trip. The content type is the server's business either way.
const BYTES = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7) % 251));

const results = [];
const check = (name, pass, extra = "") =>
  results.push(`${pass ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/pic.jpg")) {
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store" });
    res.end(BYTES);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<!doctype html><title>page</title><body>");
});
await new Promise((r) => server.listen(WEB_PORT, r));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "siluet-capture-"));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(dir, "profile")}`,
  "--headless", "--no-first-run", "--no-default-browser-check", PAGE,
], { stdio: "ignore" });

async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      if (list.some((t) => t.type === "page" && t.webSocketDebuggerUrl)) return list;
    } catch (_e) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`Chrome never opened a debugging port on ${CDP_PORT}`);
}

function client(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();
  const events = [];
  const waiters = [];
  socket.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    } else if (m.method) {
      events.push(m);
      waiters.forEach((w) => w(m));
    }
  };
  const ready = new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return { ready, send, events, on: (fn) => waiters.push(fn), close: () => socket.close() };
}

try {
  const page = (await targets()).find((t) => t.type === "page");
  const cdp = client(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");

  // ── the way it works: intercept the response, take the body, let it through ──
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: `*${PIC.split("/").pop()}*`, requestStage: "Response" }] });
  const paused = new Promise((resolve) => cdp.on((m) => {
    if (m.method === "Fetch.requestPaused") resolve(m.params);
  }));

  // Exactly the request the content layer makes for the worker, arrayBuffer()
  // and all. The page gets an empty buffer out of it, which is the point:
  // opaque stays opaque on that side.
  const asked = cdp.send("Runtime.evaluate", {
    expression: `fetch(${JSON.stringify(PIC)}, { mode: "no-cors", cache: "reload", credentials: "include" })
      .then((r) => r.arrayBuffer()).then((b) => "opaque:" + b.byteLength).catch((e) => "failed: " + e.message)`,
    awaitPromise: true, returnByValue: true,
  });

  const stopped = await Promise.race([paused, sleep(8000).then(() => null)]);
  check("the response is caught on its way to the page", !!stopped && stopped.request.url === PIC,
    stopped ? stopped.request.url : "(never paused)");
  const type = (stopped?.responseHeaders || []).find((h) => h.name.toLowerCase() === "content-type");
  check("  carrying its content type", (type?.value || "") === "image/jpeg", JSON.stringify(type));

  const body = await cdp.send("Fetch.getResponseBody", { requestId: stopped.requestId })
    .catch((e) => ({ error: e.message }));
  check("the bytes come back to the debugger", body.base64Encoded === true && !!body.body,
    JSON.stringify(body).slice(0, 120));
  check("  and they are the picture, byte for byte", body.body === BYTES.toString("base64"),
    `${(body.body || "").length} chars vs ${BYTES.toString("base64").length}`);

  await cdp.send("Fetch.continueRequest", { requestId: stopped.requestId });
  check("  and the page still gets its answer, blind to what is in it",
    (await asked).result.value === "opaque:0", JSON.stringify((await asked).result.value));
  await cdp.send("Fetch.disable", {});

  // ── and the two ways it does not work, so nobody simplifies it back ──────────
  // Network.getResponseBody is how the inbox is read, and it cannot see this:
  // the renderer is never given an opaque body to hold.
  {
    const before = cdp.events.length;
    await cdp.send("Runtime.evaluate", {
      expression: `fetch(${JSON.stringify(PIC)} + "?again=1", { mode: "no-cors", cache: "reload" })
        .then((r) => r.arrayBuffer()).then(() => "done")`,
      awaitPromise: true, returnByValue: true,
    });
    await sleep(800);
    const seen = cdp.events.slice(before).find((e) => e.method === "Network.responseReceived"
      && e.params.response.url.includes("again=1"));
    const out = await cdp.send("Network.getResponseBody", { requestId: seen?.params.requestId })
      .then((r) => (r.body ? "still there" : "empty")).catch((e) => e.message);
    check("the way the inbox is read cannot see an opaque body", /No data found|empty/.test(out), out);
  }

  // A signed CDN URL is one long query string, and CDP url patterns read ? and *
  // as wildcards — so the pattern is the URL with those escaped. Get that wrong
  // and nothing ever pauses, which looks exactly like a picture that never came.
  {
    const url = `${PIC}?oh=00_AfL&oe=68A1*b&_nc=1`;
    const pattern = url.replace(/[\\*?]/g, (c) => `\\${c}`);   // same rule as escapePattern() in src/cdp.js
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: pattern, requestStage: "Response" }] });
    const held = new Promise((resolve) => cdp.on((m) => {
      if (m.method === "Fetch.requestPaused") resolve(m.params);
    }));
    cdp.send("Runtime.evaluate", {
      expression: `fetch(${JSON.stringify(url)}, { mode: "no-cors", cache: "reload" })
        .then((r) => r.arrayBuffer())`,
      awaitPromise: true, returnByValue: true,
    }).catch(() => {});
    const stop = await Promise.race([held, sleep(8000).then(() => null)]);
    check("a signed URL, wildcards and all, is matched exactly", stop?.request.url === url,
      stop ? stop.request.url : "(never paused)");
    if (stop) await cdp.send("Fetch.continueRequest", { requestId: stop.requestId }).catch(() => {});
    await cdp.send("Fetch.disable", {});
  }

  // The interception happens before the renderer is handed anything, so the
  // page not draining the body costs the capture nothing. Checked because the
  // opposite is true of the Network route above, and the two are easy to
  // confuse — draining stays in the content layer because it is what makes the
  // page's "done" mean the picture actually arrived, not because the bytes
  // depend on it.
  {
    const url = `${PIC}?undrained=1`;
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*undrained*", requestStage: "Response" }] });
    const held = new Promise((resolve) => cdp.on((m) => {
      if (m.method === "Fetch.requestPaused") resolve(m.params);
    }));
    cdp.send("Runtime.evaluate", {
      expression: `fetch(${JSON.stringify(url)}, { mode: "no-cors", cache: "reload" }).then((r) => r.type)`,
      awaitPromise: true, returnByValue: true,
    }).catch(() => {});
    const stop = await Promise.race([held, sleep(8000).then(() => null)]);
    const out = stop
      ? await cdp.send("Fetch.getResponseBody", { requestId: stop.requestId })
        .then((r) => (r.body === BYTES.toString("base64") ? "MATCHES" : `${String(r.body).length} chars`))
        .catch((e) => e.message)
      : "(never paused)";
    check("an undrained response is caught all the same", out === "MATCHES", out);
    if (stop) await cdp.send("Fetch.continueRequest", { requestId: stop.requestId }).catch(() => {});
    await cdp.send("Fetch.disable", {});
  }

  cdp.close();
} catch (e) {
  check("the probe ran", false, e.message);
} finally {
  chrome.kill();
  server.close();
  await sleep(300);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(results.join("\n"));
const ok = results.every((r) => r.startsWith("PASS"));
console.log(ok ? "ALL PASS" : "SOME FAILED");
process.exit(ok ? 0 : 1);
