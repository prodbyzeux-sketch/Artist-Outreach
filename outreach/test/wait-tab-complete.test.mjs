// Regression test for the run that opened a window and then sat there doing
// nothing until the page was reloaded by hand: waitTabComplete only WATCHED for
// `complete`, so a tab that reached it first was waited on for the full timeout,
// and reloading the page was what finally produced the event it wanted.
//
//   node test/wait-tab-complete.test.mjs            (no dependencies, no runner)
//   node test/wait-tab-complete.test.mjs other.js   (run it against another copy)
//
// The function is read out of background.js rather than imported: that file is a
// service worker whose top level registers chrome listeners, so importing it
// outside Chrome is not possible. Renaming the function fails the test loudly.
import { readFileSync } from "node:fs";

const SRC = process.argv[2] || new URL("../src/background.js", import.meta.url).pathname;
const source = readFileSync(SRC, "utf8");
const fn = source.match(/^function waitTabComplete[\s\S]*?^}/m);
if (!fn) throw new Error("waitTabComplete not found in background.js");

function makeChrome(initialStatus) {
  const listeners = new Set();
  return {
    listeners,
    tabs: {
      onUpdated: {
        addListener: (l) => listeners.add(l),
        removeListener: (l) => listeners.delete(l),
      },
      get: async () => ({ status: initialStatus }),
    },
    fire: (id, info) => [...listeners].forEach((l) => l(id, info)),
  };
}

const load = (chrome) => new Function("chrome", `${fn[0]}\nreturn waitTabComplete;`)(chrome);

const results = [];
const check = (name, pass, extra = "") =>
  results.push(`${pass ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);

// 1. The regression: the tab is already loaded before anyone is watching.
{
  const chrome = makeChrome("complete");
  const started = Date.now();
  const ok = await load(chrome)(7, 3000);
  check("resolves for a tab that was already complete", ok === true, `-> ${ok}`);
  check("  and does so at once, not on the timeout", Date.now() - started < 500, `${Date.now() - started}ms`);
  check("  and unsubscribes", chrome.listeners.size === 0, `${chrome.listeners.size} left`);
}

// 2. The ordinary case: still loading, finishes later.
{
  const chrome = makeChrome("loading");
  const p = load(chrome)(7, 3000);
  setTimeout(() => chrome.fire(7, { status: "complete" }), 50);
  check("resolves when the tab finishes later", (await p) === true);
  check("  and unsubscribes", chrome.listeners.size === 0, `${chrome.listeners.size} left`);
}

// 3. Another tab finishing is not ours.
{
  const chrome = makeChrome("loading");
  const p = load(chrome)(7, 300);
  setTimeout(() => chrome.fire(99, { status: "complete" }), 30);
  check("ignores a different tab", (await p) === false);
}

// 4. Nothing ever happens → gives up and says so.
{
  const chrome = makeChrome("loading");
  check("times out to false when the page never loads", (await load(chrome)(7, 250)) === false);
}

// 5. A tab that has gone away must not hang the run.
{
  const chrome = makeChrome("loading");
  chrome.tabs.get = async () => { throw new Error("No tab with id: 7"); };
  const started = Date.now();
  check("a missing tab resolves false instead of hanging",
    (await load(chrome)(7, 3000)) === false && Date.now() - started < 500);
}

console.log(results.join("\n"));
console.log(results.every((r) => r.startsWith("PASS")) ? "ALL PASS" : "SOME FAILED");
process.exit(results.every((r) => r.startsWith("PASS")) ? 0 : 1);
