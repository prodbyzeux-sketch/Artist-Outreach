// Relay between the page world (where the hook lives) and the extension. Holds
// no logic on purpose: everything it forwards is untrusted text written by other
// people, so it is parsed in the service worker and rendered as text, never HTML.

// Wrapped: the outreach half shares this isolated world, so a name declared
// at top level here could collide with one declared there — and a duplicate
// `const` is a SyntaxError that kills the whole content layer, both halves at
// once. Nothing in this file needs to be visible outside it.
(() => {
  const TAG = 'ao-crm';
  const pendingReplays = new Map();
  let replaySeq = 0;

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const msg = event.data;
    if (!msg || msg[TAG] !== true) return;

    if (msg.kind === 'replay-result') {
      const resolve = pendingReplays.get(msg.id);
      if (resolve) { pendingReplays.delete(msg.id); resolve(msg.result); }
      return;
    }
    if (msg.kind === 'seen') {
      // Diagnostics: a query name, a size, a yes/no. Named separately because
      // it carries different fields — and because forwarding `body` here would
      // hand the worker a second copy of every response for nothing.
      chrome.runtime.sendMessage({ type: 'ig-capture', kind: 'seen', name: msg.name, bytes: msg.bytes, threads: msg.threads })
        .catch(() => {});
      return;
    }
    if (msg.kind === 'inbox' || msg.kind === 'thread' || msg.kind === 'page-template' || msg.kind === 'hook-ready') {
      // The worker may be asleep; a failed send is not worth surfacing.
      chrome.runtime.sendMessage({ type: 'ig-capture', kind: msg.kind, url: msg.url, body: msg.body, template: msg.template })
        .catch(() => {});
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'replay') return undefined;
    const id = `r${++replaySeq}`;
    const timer = setTimeout(() => {
      if (pendingReplays.delete(id)) sendResponse({ status: 0, url: '', body: '', error: 'replay timed out' });
    }, 20000);
    pendingReplays.set(id, (result) => { clearTimeout(timer); sendResponse(result); });
    window.postMessage({ [TAG]: true, kind: 'replay', id, template: message.template }, window.location.origin);
    return true; // response arrives asynchronously
  });
})();
