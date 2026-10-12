// Does the work window keep working when it is out of sight?
//
//   node test/occlusion.test.mjs        (headful — it needs real windows)
//
// This is the bug reported as "рассылка не идёт, если окно на другом рабочем
// столе". A window on another macOS Space is OCCLUDED, and Chrome stops
// producing frames for an occluded window. Everything in the HTML rendering step
// stops with them — requestAnimationFrame, IntersectionObserver, ResizeObserver,
// CSS transitions — and the page's timers drop to a wake a second. Instagram
// builds its lists and threads on exactly those, so the run stands still until
// somebody looks at the window again.
//
// Audio does NOT fix this. A tab playing audio is exempt from timer throttling
// and nothing else: measured on an occluded window with the oscillator running,
// rAF was still 0. Focus emulation is the switch that works, and this holds it
// to that, in both directions.
//
// Occlusion here is a window fully covered by another window. That is the same
// NSWindowOcclusionState path a window on another Space takes; covering one is
// the half of it a script can cause on its own.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9448;
const SAMPLE_MS = 6000;

const results = [];
const check = (name, pass, extra = "") =>
  results.push(`${pass ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "siluet-occlusion-"));
for (const n of ["under", "over", "next"]) {
  fs.writeFileSync(path.join(dir, `${n}.html`), `<!doctype html><title>${n}</title><body style="background:#111">`);
}
const url = (n) => `file://${path.join(dir, `${n}.html`)}`;

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(dir, "profile")}`,
  "--no-first-run", "--no-default-browser-check", "--window-size=700,500", url("under"),
], { stdio: "ignore" });

async function targets() {
  for (let i = 0; i < 60; i++) {
    try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); }
    catch (_e) { await sleep(250); }
  }
  throw new Error(`Chrome never opened a debugging port on ${PORT}`);
}

function client(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  };
  const ready = new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return { ready, send, close: () => socket.close() };
}

// Frames and timers together: the run needs both, and only one of them was ever
// the audio's business.
const PROBE = `(() => {
  globalThis.__stop && globalThis.__stop();
  let live = true; globalThis.__stop = () => { live = false; };
  globalThis.__raf = 0; globalThis.__gaps = [];
  const frame = () => { if (!live) return; globalThis.__raf++; requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  let last = Date.now();
  const tick = () => { if (!live) return; const n = Date.now(); globalThis.__gaps.push(n - last); last = n; setTimeout(tick, 250); };
  setTimeout(tick, 250);
  return true;
})()`;

async function measure(cdp) {
  const ev = async (e) => (await cdp.send("Runtime.evaluate", { expression: e, returnByValue: true })).result.value;
  await ev(PROBE);
  await sleep(SAMPLE_MS);
  const gaps = (await ev("globalThis.__gaps.slice()")).sort((a, b) => a - b);
  return {
    raf: await ev("globalThis.__raf"),
    timer: gaps[Math.floor(gaps.length / 2)] ?? null,
    visibility: await ev("document.visibilityState"),
  };
}
const shape = (m) => `rAF=${m.raf} timers=${m.timer}ms ${m.visibility}`;

async function waitHidden(cdp) {
  const ev = async (e) => (await cdp.send("Runtime.evaluate", { expression: e, returnByValue: true })).result.value;
  for (let i = 0; i < 40; i++) {
    if ((await ev("document.visibilityState")) === "hidden") { await sleep(1200); return true; }
    await sleep(250);
  }
  return false;
}

try {
  const under = (await targets()).find((t) => t.url.endsWith("under.html"));
  const cdp = client(under.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  const { windowId } = await cdp.send("Browser.getWindowForTarget");
  await cdp.send("Browser.setWindowBounds",
    { windowId, bounds: { left: 60, top: 60, width: 700, height: 500, windowState: "normal" } });
  await cdp.send("Page.bringToFront");
  await sleep(900);

  // A second window placed over the first. Fully covered is occluded.
  const { targetId } = await cdp.send("Target.createTarget", { url: url("over"), newWindow: true });
  await sleep(1200);
  const over = (await targets()).find((t) => t.id === targetId);
  const overCdp = client(over.webSocketDebuggerUrl);
  await overCdp.ready;
  const { windowId: overWin } = await overCdp.send("Browser.getWindowForTarget");
  await overCdp.send("Browser.setWindowBounds",
    { windowId: overWin, bounds: { left: 40, top: 40, width: 760, height: 560, windowState: "normal" } });
  await overCdp.send("Page.bringToFront");
  // macOS notices the covering a moment after it happens, and measuring across
  // that moment reads as "still rendering" — wait for the page to say hidden,
  // then let it settle, or this test flakes on its own first check.
  await waitHidden(cdp);

  const covered = await measure(cdp);
  check("a covered window stops rendering", covered.raf === 0, shape(covered));
  check("  and its timers are throttled", covered.timer >= 800, shape(covered));
  check("  and the page calls itself hidden", covered.visibility === "hidden", shape(covered));

  // What src/cdp.js sends: keepRendering().
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await sleep(500);
  const kept = await measure(cdp);
  check("focus emulation starts the frames again", kept.raf > 100, shape(kept));
  check("  and takes the throttling off the timers", kept.timer <= 400, shape(kept));
  check("  and the page calls itself visible", kept.visibility === "visible", shape(kept));

  // The one navigation a run makes must not cost it.
  await cdp.send("Page.navigate", { url: url("next") });
  await sleep(1800);
  const after = await measure(cdp);
  check("  and it survives a navigation", after.raf > 100 && after.timer <= 400, shape(after));

  // Both directions, or the checks above proved something about the window
  // rather than about the emulation.
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  await sleep(500);
  const off = await measure(cdp);
  check("  turning it off freezes the window again", off.raf === 0 && off.timer >= 800, shape(off));

  overCdp.close();
  cdp.close();
} catch (e) {
  check("the probe ran", false, e.message);
} finally {
  chrome.kill();
  await sleep(500);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(results.join("\n"));
const ok = results.every((r) => r.startsWith("PASS"));
console.log(ok ? "ALL PASS" : "SOME FAILED");
process.exit(ok ? 0 : 1);
