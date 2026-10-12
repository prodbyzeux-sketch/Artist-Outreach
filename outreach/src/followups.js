// followups.js — who is owed a follow-up, which one, and what goes out next.
//
// A follow-up is a second (third, …) message into a conversation that already
// exists. That makes it a different animal from the opener in three ways, and
// every rule here follows from one of them:
//
//   · The path is fixed. There is nothing to look at on their profile and no
//     post to reply to — Direct search, open the thread, type. Always.
//   · It stops the moment they answer. A follow-up sent after a reply is not
//     outreach, it is talking over someone.
//   · It never jumps the queue. First-touch DMs are the run; follow-ups are what
//     the run does once it has run out of new people.
//
// Pure — no chrome APIs, no DOM — so the ordering can be tested without a
// browser. Message text (spintax, {variables}) is built by the caller.

import { hasReplied } from "./stats.js";

export const HOUR = 3600000;

// Pauses between follow-ups are 20% shorter than between openers: the account
// is not opening new conversations, which is the action Instagram meters.
export const FOLLOWUP_PACE = 0.8;

// The last time WE wrote to this lead — the opener, or the newest follow-up.
export function lastTouchMs(lead) {
  const done = lead.followups || [];
  return done.length ? Math.max(lead.ts || 0, done[done.length - 1].ts || 0) : (lead.ts || 0);
}

// One lead's standing, in the words the queue shows:
//   off      — not a candidate at all (never sent to, removed, follow-ups off)
//   replied  — they answered; nothing more goes out
//   stopped  — we could not reach them and gave up (see followupsOff)
//   done     — every configured step has gone out
//   waiting  — a step is queued, the wait has not passed yet
//   due      — a step is ready to go now
// An empty box in the form is a step you have not written yet, not a step that
// sends nothing. Dropped here so no caller has to remember to.
export const liveSteps = (steps) => (steps || []).filter((s) => s.text && s.text.trim());

export function followupStatus(lead, inbox, rawSteps, settings, now = Date.now()) {
  const steps = liveSteps(rawSteps);
  const sent = (lead.followups || []).length;
  if (!settings.followupsEnabled || !steps.length) return { state: "off", sent };
  if (lead.removed || lead.status !== "sent" || !lead.ts) return { state: "off", sent };
  if (hasReplied(lead, inbox)) return { state: "replied", sent };
  if (lead.followupsOff) return { state: "stopped", sent, error: lead.followupError };
  if (sent >= steps.length) return { state: "done", sent };

  const dueAt = lastTouchMs(lead) + Math.max(0, settings.followupAfterHours || 0) * HOUR;
  const state = now >= dueAt ? "due" : "waiting";
  return { state, sent, dueAt, step: steps[sent], index: sent };
}

// Everything owed right now, oldest debt first — a lead that has been waiting
// three days goes before one that came due a minute ago.
export function dueFollowups(leads, inbox, steps, settings, now = Date.now()) {
  return leads
    .map((lead) => ({ lead, ...followupStatus(lead, inbox, steps, settings, now) }))
    .filter((r) => r.state === "due")
    .sort((a, b) => a.dueAt - b.dueAt);
}

// The counts the Leads section shows above the queue.
export function followupSummary(leads, inbox, steps, settings, now = Date.now()) {
  const out = { due: 0, waiting: 0, replied: 0, done: 0, stopped: 0, sent: 0 };
  for (const lead of leads) {
    const s = followupStatus(lead, inbox, steps, settings, now);
    out.sent += s.sent;
    if (s.state in out) out[s.state]++;
  }
  return out;
}

// The next unit of work for the run, or null when there is none left.
//
// Order is the whole point: every first-touch DM in the queue goes out before
// the first follow-up does. The two caps are separate — running out of opener
// budget is not a reason to stop following up on people already written to.
export function nextJob({ leads, inbox, steps, settings, state, now = Date.now() }) {
  const live = leads.filter((l) => !l.removed);

  const dmCapped = settings.maxPerRun > 0 && (state.sent || 0) >= settings.maxPerRun;
  if (!dmCapped) {
    const lead = live.find((l) => l.status === "pending");
    if (lead) return { kind: "dm", lead };
  }

  if (settings.followupMaxPerRun > 0 && (state.followupsSent || 0) >= settings.followupMaxPerRun) return null;
  const owed = dueFollowups(live, inbox, steps, settings, now)[0];
  return owed ? { kind: "followup", lead: owed.lead, step: owed.step, index: owed.index } : null;
}
