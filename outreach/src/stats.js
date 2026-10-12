// stats.js — everything the dashboard shows, derived from the leads and the
// inbox facts. Pure functions over plain data, so the numbers can be tested
// without a browser.
//
// A lead counts as replied when its conversation carries an inbound message
// after our first outbound (see inbox.js). Matching is by `threadId`, recorded
// at send time; the handle is only a fallback for leads sent before that field
// existed.

const DAY = 86400000;

export function factsForLead(lead, inbox) {
  if (lead.threadId && inbox[lead.threadId]) return inbox[lead.threadId];
  return Object.values(inbox).find((f) => f.username && f.username === lead.handle) || null;
}

// A removed lead is out of the queue AND out of the numbers. Removal here is a
// tombstone rather than a splice — a table re-import would otherwise bring the
// lead straight back, see the header of src/ui/leads.js — and counting those
// meant a list you had deleted went on filling the dashboard for ever, beside
// the list that replaced it. Restore puts the lead back, history and all.
const sentLeads = (leads) => leads.filter((l) => !l.removed && l.status === "sent" && l.ts);

// Did this lead answer US? An inbound after our own send — a conversation that
// was already going before the run does not count. One definition, shared: the
// dashboard draws it and src/followups.js stops writing to people because of it,
// and those two disagreeing would be a bug nobody could see.
export function hasReplied(lead, inbox) {
  const f = factsForLead(lead, inbox);
  return !!(f && f.replied && (!lead.ts || f.firstReplyMs >= lead.ts - 60000));
}

// One pass over the sent leads, tagging each with its reply. Everything below
// works off this so a lead is never counted two different ways.
export function outcomes(leads, inbox) {
  return sentLeads(leads).map((l) => {
    const f = factsForLead(l, inbox);
    const replied = hasReplied(l, inbox);
    return {
      lead: l,
      replied,
      // Time from our send to their answer. Uses our own send stamp rather than
      // the thread's first outbound, which may belong to an older conversation.
      replyLagMs: replied && f.firstReplyMs > l.ts ? f.firstReplyMs - l.ts : null,
    };
  });
}

const rate = (replied, sent) => (sent ? replied / sent : 0);

function tally(rows) {
  const sent = rows.length;
  const replied = rows.filter((r) => r.replied).length;
  return { sent, replied, rate: rate(replied, sent) };
}

export function headline(rows) {
  const lags = rows.map((r) => r.replyLagMs).filter((v) => v != null).sort((a, b) => a - b);
  return {
    ...tally(rows),
    medianReplyLagMs: lags.length ? lags[Math.floor(lags.length / 2)] : null,
  };
}

// Reply rate per opener. `messages` gives each variant its text; a lead whose
// variant has since been deleted lands under "(removed variant)" rather than
// vanishing from the totals.
export function byOpener(rows, messages) {
  const texts = new Map(messages.map((m) => [m.id, m.text]));
  const groups = new Map();
  for (const r of rows) {
    const id = r.lead.sentMessageId || "";
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(r);
  }
  return [...groups.entries()]
    .map(([id, rs]) => ({
      id,
      text: texts.get(id) || (id ? "(removed variant)" : "(sent before variants were recorded)"),
      ...tally(rs),
    }))
    .sort((a, b) => b.sent - a.sent);
}

export function byPath(rows) {
  const groups = new Map();
  for (const r of rows) {
    const f = r.lead.format || "unknown";
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f).push(r);
  }
  return [...groups.entries()].map(([format, rs]) => ({ format, ...tally(rs) }))
    .sort((a, b) => b.sent - a.sent);
}

// Reply rate by hour of day, in the sender's own timezone — the input to "when
// is it worth sending". Hours nobody has sent in are still listed, so the gaps
// in the day are visible rather than silently closed up.
export function byHour(rows) {
  const buckets = Array.from({ length: 24 }, (_, hour) => ({ hour, sent: 0, replied: 0, rate: 0 }));
  for (const r of rows) {
    const b = buckets[new Date(r.lead.ts).getHours()];
    b.sent++;
    if (r.replied) b.replied++;
  }
  for (const b of buckets) b.rate = rate(b.replied, b.sent);
  return buckets;
}

// The best hour, or an honest refusal. A 100% rate off three sends is noise,
// and a dashboard that prints it as advice is worse than one that says nothing.
export const MIN_SAMPLE = 8;
export function bestHour(buckets) {
  const eligible = buckets.filter((b) => b.sent >= MIN_SAMPLE);
  if (!eligible.length) {
    const most = Math.max(0, ...buckets.map((b) => b.sent));
    return { hour: null, reason: `not enough sends yet — the busiest hour has ${most}, ${MIN_SAMPLE} needed` };
  }
  const best = eligible.reduce((a, b) => (b.rate > a.rate ? b : a));
  return { hour: best.hour, sent: best.sent, replied: best.replied, rate: best.rate, reason: null };
}

// ── the GitHub grid ───────────────────────────────────────────────────────────
// Sends per day for the trailing year, laid out the way GitHub does it: columns
// are weeks, rows are weekdays, the last column is the current week.
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

export function activityGrid(leads, inbox, today = Date.now(), weeks = 53) {
  const perDay = new Map();
  for (const l of sentLeads(leads)) {
    const key = startOfDay(l.ts);
    const cur = perDay.get(key) || { sent: 0, replied: 0 };
    cur.sent++;
    // hasReplied, not the thread's own flag: a conversation that was already
    // going before we wrote is not somebody answering us, and the squares must
    // mean the same thing as every other number on the page.
    if (hasReplied(l, inbox)) cur.replied++;
    perDay.set(key, cur);
  }

  // Walk back to the Sunday that opens the first column, so every column is a
  // full week and the weekday rows line up.
  const end = startOfDay(today);
  const lastSunday = end - new Date(end).getDay() * DAY;
  const firstDay = lastSunday - (weeks - 1) * 7 * DAY;

  const columns = [];
  for (let w = 0; w < weeks; w++) {
    const col = [];
    for (let d = 0; d < 7; d++) {
      const date = firstDay + (w * 7 + d) * DAY;
      const hit = perDay.get(date);
      col.push({ date, future: date > end, sent: hit ? hit.sent : 0, replied: hit ? hit.replied : 0 });
    }
    columns.push(col);
  }

  const busiest = Math.max(0, ...[...perDay.values()].map((v) => v.sent));
  return { columns, busiest, total: [...perDay.values()].reduce((n, v) => n + v.sent, 0) };
}

// Four filled steps like GitHub's, scaled to the busiest day so a quiet week
// still shows shape instead of one faint square.
export function heatLevel(sent, busiest) {
  if (!sent) return 0;
  if (busiest <= 1) return 4;
  return Math.min(4, 1 + Math.floor((sent / busiest) * 3.999));
}
