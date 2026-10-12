// Runs test/tables-ui.html in a real headless Chrome and reports what it found.
//
//   node test/tables-ui.test.mjs
//
// The harness needs a real browser for real reasons: ES modules will not load
// over file://, the import path goes through File.text(), and the queue is only
// ever right if the DOM the person clicks is the DOM under test. A throwaway
// profile per run also means an empty HTTP cache — the static server sends no
// Cache-Control, and Chrome will happily execute yesterday's module otherwise.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serve, PORT, CHROME } from "./shot-lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await serve();
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "siluet-tables-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--remote-debugging-port=9424", `--user-data-dir=${profileDir}`,
  "--no-first-run", "--no-default-browser-check", "about:blank",
], { stdio: "ignore" });

const done = (code) => {
  chrome.kill();
  server.close();
  fs.rmSync(profileDir, { recursive: true, force: true });
  process.exit(code);
};

async function pageTarget() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch("http://127.0.0.1:9424/json/list")).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch (_e) { /* the port isn't up yet */ }
    await sleep(200);
  }
  throw new Error("Chrome never opened a debugging port on 9424");
}

try {
  const target = await pageTarget();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

  let nextId = 0;
  const pending = new Map();
  socket.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (!m.id || !pending.has(m.id)) return;
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++nextId, { resolve, reject });
    socket.send(JSON.stringify({ id: nextId, method, params }));
  });

  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/test/tables-ui.html` });

  let report = "";
  for (let i = 0; i < 300; i++) {
    await sleep(100);
    const res = await send("Runtime.evaluate", {
      expression: 'document.getElementById("out")?.textContent || ""', returnByValue: true,
    });
    report = res.result.value || "";
    if (report && report !== "running…") break;
  }

  console.log(report || "the harness never reported");
  const passed = /ALL PASS\s*$/.test(report);
  console.log(passed ? "\nALL PASS" : "\nSOME FAILED");
  done(passed ? 0 : 1);
} catch (e) {
  console.error(e);
  done(1);
}
