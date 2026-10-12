// Trusted keystrokes for the CRM's reply box.
//
// Instagram's DM composer is Lexical, and it submits on the EDITING COMMAND the
// browser derives from a real Enter — not on a keydown listener. A KeyboardEvent
// dispatched from a content script is untrusted: listeners do see it, but Blink
// runs no command. Measured in Chrome: the synthetic press produced keydown and
// keypress and no `beforeinput` at all, and the field did not change. That is why
// a reply used to be typed into the composer and then just sit there — and why
// there is no button to fall back to, since this surface has none
// (outreach/src/content/direct.js:328).
//
// So the keystrokes come from chrome.debugger, the way the send run drives its
// own window. Chrome's "extension is debugging this browser" bar is the price;
// the session is attached for the length of one reply and handed straight back.
//
// The run's driver (outreach/src/cdp.js) is deliberately NOT reused: it keeps one
// attached tab id for the whole extension, so borrowing it mid-run would take the
// input away from a send in flight. Chrome tracks a debugger session per tab and
// these are always different tabs — the linked tab never adopts the work tab
// (crm/sw.js:166).

const PROTOCOL = '1.3';

/** Long enough for Lexical to apply the insert before the key that submits it. */
const SETTLE_MS = 120;

/**
 * Enter, carrying the text Blink turns into the submit command. Ported from
 * outreach/src/cdp.js:273, where the missing `text` cost a long time to find.
 */
async function pressEnter(target) {
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
    type: 'keyDown', ...key, text: '\r', unmodifiedText: '\r',
  });
  await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', ...key });
}

/**
 * Put `text` into whatever has focus in `tabId` and send it. The caller focuses
 * the composer first — finding it is the content script's job, since it is the
 * one in the page (crm/content/compose.js).
 *
 * Inserted whole rather than typed character by character: this is a person
 * answering one conversation by hand, not the send run, which paces itself to
 * look human because it writes to hundreds of strangers.
 */
export async function insertAndSend(tabId, text) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, PROTOCOL);
  } catch (e) {
    const reason = String(e?.message ?? e);
    // Chrome allows one debugger client per tab, and the everyday second one is
    // the user's own DevTools. That has a way out, so it gets its own code.
    return { ok: false, error: /already attached|another debugger/i.test(reason) ? 'input-busy' : reason };
  }
  try {
    // The linked tab is usually in the background, where Chrome tells the page it
    // has no focus and Lexical ignores the keystrokes (outreach/src/cdp.js:182).
    await chrome.debugger.sendCommand(target, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    await chrome.debugger.sendCommand(target, 'Input.insertText', { text });
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    await pressEnter(target);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  } finally {
    // Never left attached: the debugging bar would sit on the user's Instagram
    // tab until they restarted Chrome.
    try { await chrome.debugger.detach(target); } catch { /* the tab is already gone */ }
  }
}
