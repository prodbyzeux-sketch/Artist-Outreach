// run.js — the run bar: Start/Stop, progress, the live log, and the one question
// Start has to ask, when a capped run stopped part-way through its cap.

import { STATUS, getRunState } from "../storage.js";
import { audienceFilterProblem } from "../audience.js";
import { $ } from "./dom.js";

let lastState = {};
let errTimer;
let readSettings = () => ({});
let writeLimit = () => {};

const PHASE_TEXT = {
  opening: "opening Instagram…",
  inbox: "reading the inbox…",
};

// The cap is counted against what the run has sent, and a continued run brings
// the last one's count with it — so "5 of 20" is the whole story of the cap,
// and "5 sent" on its own is only half of it.
const cap = () => readSettings().maxPerRun || 0;
const sentSoFar = (state) => (cap() ? `${state.sent} of ${cap()} sent` : `${state.sent} sent`);

// What the run has done so far, in the order it happens. The follow-up count
// only appears once the run is on them, so an ordinary send says one thing.
function tally(state) {
  const parts = [sentSoFar(state)];
  if (state.failed) parts.push(`${state.failed} failed`);
  if (state.phase === "followups" || state.followupsSent) {
    parts.push(`${state.followupsSent || 0}/${state.followupTotal || 0} follow-ups`);
  }
  parts.push(`${Math.max(0, state.currentIndex + 1)}/${state.total}`);
  return parts.join(" · ");
}

export const runIsActive = () => !!lastState.running;

export function appendLog(text, level) {
  const log = $("log");
  const line = document.createElement("div");
  if (level === "error") line.className = "err";
  line.textContent = text;
  log.append(line);
  while (log.childElementCount > 160) log.firstElementChild.remove();
  log.scrollTop = log.scrollHeight;
}

export function updateRunUI(state, onRunningChanged) {
  const was = !!lastState.running;
  lastState = state;
  const running = !!state.running;

  // The status pill is gone with the top bar; the logo breathes instead.
  $("logo").classList.toggle("is-running", running);

  const btn = $("runBtn");
  btn.textContent = running ? "Stop" : "Start";
  btn.classList.toggle("is-stop", running);

  if (running) {
    $("resumeAsk").hidden = true;
    // Before the first lead there are no counters to show, and that stretch is
    // the longest one — the window opening and the whole inbox scan.
    $("progress").textContent = PHASE_TEXT[state.phase] || tally(state);
  } else if (state.total) {
    $("progress").textContent = `done · ${sentSoFar(state)}`
      + (state.failed ? ` · ${state.failed} failed` : "")
      + (state.followupsSent ? ` · ${state.followupsSent} follow-ups` : "");
  } else {
    $("progress").textContent = "";
  }

  if (was !== running && onRunningChanged) onRunningChanged(running);
}

// A validation error next to Start — the small log is easy to miss.
function flashError(text, onRunningChanged) {
  appendLog(text, "error");
  const p = $("progress");
  p.textContent = text;
  p.style.color = "var(--danger)";
  clearTimeout(errTimer);
  errTimer = setTimeout(() => { p.style.color = ""; updateRunUI(lastState, onRunningChanged); }, 4500);
}

// A capped run that stopped part-way leaves two different things Start could
// mean: finish those 20, or begin another 20. The counter carries over only for
// the first, so the run bar asks rather than guessing — and the new run's cap
// can be set right here, since that is the number being decided.
const leftOfCap = (state) => (cap() && state.sent > 0 && state.sent < cap() ? cap() - state.sent : 0);

function askResume(state, left) {
  $("resumeText").textContent = `The last run sent ${state.sent} of ${cap()}.`;
  $("resumeContinue").textContent = `Finish it — ${left} left`;
  $("resumeLimit").value = cap();
  $("resumeAsk").hidden = false;
}

export async function initRun({ messages, leads, settings, setLimit, onRunningChanged }) {
  readSettings = settings;
  writeLimit = setLimit;

  // Reloading the extension leaves this page running with a dead port, and the
  // click then does nothing at all — silently. Say so instead.
  const tell = (type, extra) => chrome.runtime.sendMessage({ type, ...extra }).catch(() =>
    flashError("The extension was reloaded — refresh this page and press again", onRunningChanged));

  const begin = (resume) => {
    $("resumeAsk").hidden = true;
    $("log").innerHTML = "";
    tell("START", { resume });
  };

  $("runBtn").addEventListener("click", async () => {
    const state = await getRunState();
    if (state.running) {
      tell("STOP");
      return;
    }
    if (!messages().some((m) => m.text.trim())) {
      flashError("Add at least one message", onRunningChanged);
      return;
    }
    if (!leads().some((l) => l.status === STATUS.pending && !l.removed)) {
      flashError("No leads to send to — upload a table or paste usernames", onRunningChanged);
      return;
    }
    // Bounds nobody could satisfy would send the whole queue to `skipped` in one
    // run, and look exactly like a list that turned out to be worthless.
    const impossible = audienceFilterProblem(readSettings());
    if (impossible) {
      flashError(impossible, onRunningChanged);
      return;
    }
    const left = leftOfCap(state);
    if (left) return askResume(state, left);
    begin(false);
  });

  $("resumeContinue").addEventListener("click", () => begin(true));
  $("resumeFresh").addEventListener("click", () => {
    writeLimit($("resumeLimit").value);
    begin(false);
  });
  $("resumeCancel").addEventListener("click", () => { $("resumeAsk").hidden = true; });
  $("resumeLimit").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("resumeFresh").click();
  });

  updateRunUI(await getRunState(), onRunningChanged);
}
