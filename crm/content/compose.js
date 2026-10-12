// Prepares Instagram's real composer for a reply, and says whether the reply
// left. The keystrokes are NOT here: an untrusted KeyboardEvent runs no editing
// command, so Lexical never submits on one — the text and the Enter come from
// the service worker over chrome.debugger (crm/trusted-input.js). What is left
// for this file is what only the page can do: find the composer, put the caret
// in it, and read the one signal Instagram gives back.
//
// Everything here is best-effort against markup we do not control, so every
// failure returns a specific reason instead of a silent no-op.

// Wrapped: the outreach half shares this isolated world, so a name declared
// at top level here could collide with one declared there — and a duplicate
// `const` is a SyntaxError that kills the whole content layer, both halves at
// once. Nothing in this file needs to be visible outside it.
(() => {
  const COMPOSER = 'div[contenteditable="true"][role="textbox"], textarea[placeholder]';

  /** Long enough to outlast a slow acknowledgement, short enough to still be an answer. */
  const CONFIRM_MS = 4000;

  /** A thread the linked tab has just navigated to may still be rendering. */
  const COMPOSER_MS = 8000;

  /**
   * Wait for something about the page to become true, WATCHING the DOM instead of
   * polling it. The linked tab is a background tab, and Chrome holds setTimeout in
   * a hidden tab to roughly once a second — much less often once it has been
   * hidden a while. Polling therefore answered whole seconds after the fact, which
   * is what made a sent message look like it was still going. Mutations are
   * delivered either way; the timeout is only an upper bound, and being throttled
   * can only make it later than asked, never earlier than the answer.
   */
  function waitFor(test, root, timeoutMs) {
    const found = test();
    if (found) return Promise.resolve(found);

    return new Promise((resolve) => {
      let observer;
      let timer;
      const done = (result) => { clearTimeout(timer); observer.disconnect(); resolve(result); };
      observer = new MutationObserver(() => {
        const hit = test();
        if (hit) done(hit);
      });
      observer.observe(root, { childList: true, characterData: true, subtree: true });
      timer = setTimeout(() => done(null), timeoutMs);
    });
  }

  const composerText = (node) => (node.isContentEditable ? node.innerText : node.value) ?? '';

  /** The composer as it is right now — React replaces the editor around an insert. */
  const findComposer = () => document.querySelector(COMPOSER);

  /** Put the caret where the worker's keystrokes will land, and leave it empty. */
  async function focusComposer() {
    if (!location.pathname.startsWith('/direct/t/')) return { ok: false, error: 'not-on-thread' };

    const composer = await waitFor(findComposer, document.documentElement, COMPOSER_MS);
    if (!composer) return { ok: false, error: 'no-composer' };

    composer.focus();
    // A leftover draft would get our text appended to it — clear it first. These
    // are editing commands the browser itself runs, so they work from here where
    // a synthetic keystroke would not.
    if (composerText(composer).trim()) {
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
    }
    return { ok: true };
  }

  /**
   * Instagram clears the composer once the message leaves; that is the only
   * signal available without claiming a send that never happened.
   *
   * The container is what is watched, not the editor: React replaces the editor
   * node around a send, and a detached node reads as empty — which would report
   * every failed send as delivered. So emptiness is re-read through the selector
   * each time, never off the node this started with.
   */
  async function confirmSent() {
    const composer = findComposer();
    if (!composer) return { ok: false, error: 'no-composer' };

    const empty = () => {
      const node = findComposer();
      return Boolean(node) && composerText(node).trim() === '';
    };
    const cleared = await waitFor(empty, composer.parentNode ?? composer, CONFIRM_MS);
    return cleared ? { ok: true } : { ok: false, error: 'not-sent' };
  }

  const handlers = { 'focus-composer': focusComposer, 'confirm-sent': confirmSent };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const handler = handlers[message?.type];
    if (!handler) return undefined;
    Promise.resolve(handler()).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
    return true;
  });
})();
