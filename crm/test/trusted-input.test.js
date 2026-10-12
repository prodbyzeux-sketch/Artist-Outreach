import test from 'node:test';
import assert from 'node:assert/strict';

import { insertAndSend } from '../trusted-input.js';

// The whole point of this module is that the page receives REAL input events, so
// what is worth testing is the shape of what goes down the wire — and that the
// debugger is always handed back. A session left attached leaves Chrome's
// "extension is debugging this browser" bar on the user's Instagram tab forever.

function stubChrome({ failOn = null, attachError = null } = {}) {
  const trace = [];
  globalThis.chrome = {
    runtime: { lastError: undefined },
    debugger: {
      async attach(target, version) {
        trace.push(`attach:${target.tabId}:${version}`);
        if (attachError) throw new Error(attachError);
      },
      async sendCommand(target, method, params) {
        trace.push(`${method}:${JSON.stringify(params ?? {})}`);
        if (failOn === method) throw new Error('command failed');
      },
      async detach(target) { trace.push(`detach:${target.tabId}`); },
    },
  };
  return trace;
}

test('the text is inserted whole and submitted with a trusted Enter', async () => {
  const trace = stubChrome();
  const result = await insertAndSend(7, 'привет, свёл бы трек');

  assert.deepEqual(result, { ok: true });
  assert.equal(trace[0], 'attach:7:1.3');
  assert.equal(trace.at(-1), 'detach:7', 'the session is always handed back');

  const insert = trace.find((line) => line.startsWith('Input.insertText'));
  assert.ok(insert?.includes('привет, свёл бы трек'), 'the message goes in as one insert');

  // The linked tab is normally in the background, and an unfocused page ignores
  // the keystrokes — so this has to come before anything is typed.
  const focus = trace.find((line) => line.startsWith('Emulation.setFocusEmulationEnabled'));
  assert.ok(focus?.includes('"enabled":true'));
  assert.ok(trace.indexOf(focus) < trace.indexOf(insert), 'focus is emulated before the text goes in');

  const keyDown = trace.find((line) => line.startsWith('Input.dispatchKeyEvent') && line.includes('keyDown'));
  assert.ok(keyDown.includes('"key":"Enter"'), 'Enter is what submits — this surface has no Send button');
  // Blink derives the editing command from the keystroke's text; without it
  // Lexical treats the press as a bare key and the message stays in the box
  // (outreach/src/cdp.js:304).
  assert.ok(keyDown.includes('"text":"\\r"'), 'the Enter keyDown must carry \\r');

  assert.ok(
    trace.indexOf(insert) < trace.indexOf(keyDown),
    'the text has to be in the field before Enter is pressed',
  );
});

test('a failed command still hands the debugger back', async () => {
  const trace = stubChrome({ failOn: 'Input.insertText' });
  const result = await insertAndSend(7, 'привет');

  assert.equal(result.ok, false);
  assert.match(result.error, /command failed/);
  assert.equal(trace.at(-1), 'detach:7');
});

test('a tab already being debugged reports the one failure that has a way out', async () => {
  // What this really is in daily use: DevTools is open on that tab, and Chrome
  // allows one debugger client at a time. The CRM turns this code into "close
  // DevTools and send again" (crm/page/view.js).
  const trace = stubChrome({ attachError: 'Another debugger is already attached to the tab with id: 7' });
  const result = await insertAndSend(7, 'привет');

  assert.deepEqual(result, { ok: false, error: 'input-busy' });
  assert.ok(!trace.some((line) => line.startsWith('detach')), 'nothing to detach — the attach never took');
});

test('any other attach failure keeps its own words', async () => {
  stubChrome({ attachError: 'No tab with given id 7' });
  const result = await insertAndSend(7, 'привет');

  assert.equal(result.ok, false);
  assert.match(result.error, /No tab with given id/);
});
