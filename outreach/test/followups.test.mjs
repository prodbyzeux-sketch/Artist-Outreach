// The follow-up rules, which are all about ORDER and about not talking over
// people. Pure functions, so this needs no browser and no stubs.
//
//   node test/followups.test.mjs
import {
  HOUR, lastTouchMs, followupStatus, dueFollowups, followupSummary, nextJob,
} from "../src/followups.js";

const results = [];
const check = (name, pass, extra = "") =>
  results.push(`${pass ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);

const NOW = 1_800_000_000_000;
const STEPS = [{ id: "f1", text: "step one" }, { id: "f2", text: "step two" }];
const ON = { followupsEnabled: true, followupAfterHours: 48, followupMaxPerRun: 0, maxPerRun: 0 };

const lead = (over = {}) => ({
  id: "l1", handle: "someone", status: "sent", ts: NOW - 72 * HOUR, threadId: "t1", ...over,
});
const repliedInbox = (ts) => ({ t1: { threadId: "t1", username: "someone", replied: true, firstReplyMs: ts } });

// ── one lead's standing ───────────────────────────────────────────────────────
const state = (l, inbox = {}, steps = STEPS, settings = ON) =>
  followupStatus(l, inbox, steps, settings, NOW).state;

check("a lead never written to is not a candidate", state(lead({ status: "pending", ts: undefined })) === "off");
check("a removed lead is not a candidate", state(lead({ removed: true })) === "off");
check("follow-ups off means nobody is a candidate",
  state(lead(), {}, STEPS, { ...ON, followupsEnabled: false }) === "off");
check("no steps written means nobody is a candidate", state(lead(), {}, []) === "off");
check("a step that is still an empty box does not count", state(lead(), {}, [{ id: "f1", text: "  " }]) === "off");

check("48h of silence makes the first step due", state(lead()) === "due");
check("24h of silence does not", state(lead({ ts: NOW - 24 * HOUR })) === "waiting");
check("someone who answered is never followed up",
  state(lead(), repliedInbox(NOW - 60 * HOUR)) === "replied");
check("  even when a step is otherwise due",
  followupStatus(lead(), repliedInbox(NOW - 60 * HOUR), STEPS, ON, NOW).state === "replied");
check("a reply from BEFORE our opener is not a reply to us",
  state(lead(), repliedInbox(NOW - 100 * HOUR)) === "due");
check("every step sent means done",
  state(lead({ followups: [{ ts: NOW - 60 * HOUR }, { ts: NOW - 50 * HOUR }] })) === "done");
check("a lead we could not reach is stopped, not retried",
  state(lead({ followupsOff: true })) === "stopped");

// ── the wait runs from the LAST thing we said, not the first ──────────────────
{
  const l = lead({ ts: NOW - 200 * HOUR, followups: [{ ts: NOW - 10 * HOUR, stepId: "f1" }] });
  check("the wait restarts from the newest follow-up", lastTouchMs(l) === NOW - 10 * HOUR);
  check("  so step two waits its own 48h, not the opener's", state(l) === "waiting");
  const s = followupStatus(l, {}, STEPS, ON, NOW);
  check("  and the step queued is the SECOND one", s.step?.id === "f2" && s.index === 1,
    `${s.step?.id} @${s.index}`);
}

// ── the debt is paid oldest first ─────────────────────────────────────────────
{
  const leads = [
    lead({ id: "recent", ts: NOW - 49 * HOUR }),
    lead({ id: "ancient", ts: NOW - 400 * HOUR }),
    lead({ id: "notyet", ts: NOW - 2 * HOUR }),
  ];
  const due = dueFollowups(leads, {}, STEPS, ON, NOW);
  check("only what is actually owed is listed", due.length === 2, `${due.length}`);
  check("  longest wait first", due[0].lead.id === "ancient", due.map((d) => d.lead.id).join(","));
}

// ── the counts the queue shows ────────────────────────────────────────────────
{
  const leads = [
    lead({ id: "a" }),
    lead({ id: "b", ts: NOW - 2 * HOUR }),
    lead({ id: "c", followups: [{ ts: NOW - 60 * HOUR }, { ts: NOW - 55 * HOUR }] }),
    lead({ id: "d", followupsOff: true }),
    lead({ id: "e", status: "pending", ts: undefined }),
  ];
  const s = followupSummary(leads, {}, STEPS, ON, NOW);
  check("the monitor counts every state",
    s.due === 1 && s.waiting === 1 && s.done === 1 && s.stopped === 1,
    JSON.stringify(s));
  check("  and totals what has gone out", s.sent === 2, `${s.sent}`);
}

// ── what the run does next ────────────────────────────────────────────────────
const job = (leads, settings = ON, runState = {}) =>
  nextJob({ leads, inbox: {}, steps: STEPS, settings, state: runState, now: NOW });

{
  const pending = { id: "p", handle: "new", status: "pending" };
  const owed = lead({ id: "owed" });

  const first = job([owed, pending]);
  check("a first-touch DM always outranks a follow-up",
    first.kind === "dm" && first.lead.id === "p", JSON.stringify({ kind: first?.kind, id: first?.lead?.id }));

  const then = job([owed]);
  check("with the queue empty, the follow-up is next",
    then.kind === "followup" && then.lead.id === "owed" && then.step.id === "f1",
    JSON.stringify({ kind: then?.kind, step: then?.step?.id }));

  check("nothing owed and nothing pending means nothing to do",
    job([lead({ ts: NOW - 2 * HOUR })]) === null);

  check("a removed lead is never picked", job([{ ...pending, removed: true }]) === null);

  // The two caps are separate on purpose: running out of opener budget is not a
  // reason to stop following up on people already written to.
  const capped = job([owed, pending], { ...ON, maxPerRun: 3 }, { sent: 3 });
  check("maxPerRun stops the openers but not the follow-ups",
    capped.kind === "followup", JSON.stringify({ kind: capped?.kind }));

  check("followupMaxPerRun stops the follow-ups",
    job([owed], { ...ON, followupMaxPerRun: 2 }, { followupsSent: 2 }) === null);
  check("  and 0 means no cap at all",
    job([owed], { ...ON, followupMaxPerRun: 0 }, { followupsSent: 999 })?.kind === "followup");
}

console.log(results.join("\n"));
const ok = results.every((r) => r.startsWith("PASS"));
console.log(ok ? "ALL PASS" : "SOME FAILED");
process.exit(ok ? 0 : 1);
