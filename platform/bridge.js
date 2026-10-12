// bridge.js — content script on the Artist Outreach web app. Relays messages
// between the page (public/platform.js) and the service worker:
//
//   page → { source: "ao-platform", type: "ping" | "pair" | "ig-lookup", id, ... }
//   page ← { source: "ao-ext", type: "hello", id, paired, email, version }
//   page ← { source: "ao-ext", id, ...reply }
//
// `hello` carries the extension id so the app can embed the extension's own
// pages (Outreach, Inbox) in an iframe.
//
// Wrapped in an IIFE: every content script of this extension shares one world,
// and a stray top-level name here would break the others (test/tree.test.js).
(() => {
  const ORIGIN = location.origin;

  const toWorker = (msg) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ ...msg, origin: ORIGIN }, (reply) => {
        const err = chrome.runtime.lastError;
        resolve(reply || { error: err ? err.message : "no response" });
      });
    } catch (e) {
      // The extension was reloaded and this script is orphaned.
      resolve({ error: "extension reloaded — refresh the page" });
    }
  });

  const toPage = (data) => window.postMessage({ source: "ao-ext", ...data }, ORIGIN);

  async function hello() {
    const r = await toWorker({ type: "ao-hello" });
    if (!r.error) {
      toPage({
        type: "hello", extensionId: chrome.runtime.id,
        paired: !!r.paired, email: r.email || null, version: r.version || null,
      });
    }
  }

  window.addEventListener("message", async (e) => {
    if (e.source !== window || e.origin !== ORIGIN) return;
    const d = e.data;
    if (!d || d.source !== "ao-platform") return;
    if (d.type === "ping") return void hello();
    if (d.type === "pair") {
      const r = await toWorker({ type: "ao-pair", token: d.token });
      return void toPage({ id: d.id, ...r });
    }
    if (d.type === "ig-lookup") {
      const r = await toWorker({ type: "ao-ig-lookup", usernames: Array.isArray(d.usernames) ? d.usernames.slice(0, 60) : [] });
      return void toPage({ id: d.id, ...r });
    }
  });

  hello();
})();
