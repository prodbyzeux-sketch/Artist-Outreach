// sync.js — from the send run back to the platform: what happened to each
// prospect that came from Artist Outreach (sent, failed, replied).
//
// Only tables imported from the platform (source: "artist-outreach") count,
// across every campaign. Each handle only moves forward: a "replied" never goes
// back to "sent". What has been reported is remembered in `aoSync` so nothing
// is sent twice.

import { hasReplied, factsForLead } from "../outreach/src/stats.js";
import { matchColumn, tableHandle } from "../outreach/src/spintax.js";

export const SOURCE = "artist-outreach";
export const RANK = { failed: 1, sent: 2, replied: 3 };

// handle → prospect id, from the ao_id column of the platform's tables.
export function platformHandles(tables) {
  const out = new Map();
  for (const t of Array.isArray(tables) ? tables : tables ? [tables] : []) {
    if (t?.source !== SOURCE) continue;
    const m = matchColumn(t);
    if (m == null) continue;
    const idCol = (t.headers || []).findIndex((h) => String(h).trim().toLowerCase() === "ao_id");
    for (const row of t.rows || []) {
      const h = tableHandle(row[m]);
      if (h && !out.has(h)) out.set(h, idCol >= 0 ? row[idCol] || null : null);
    }
  }
  return out;
}

// Pure: { campaigns, tables, leads, inbox, last } → { events, next }.
export function collectEvents({ campaigns = [], tables = {}, leads = {}, inbox = {}, last = {} }) {
  const best = new Map(); // handle → event (the most advanced state across campaigns)
  for (const c of campaigns) {
    const handles = platformHandles(tables[c.id]);
    if (!handles.size) continue;
    for (const lead of leads[c.id] || []) {
      if (!lead || lead.removed || !handles.has(lead.handle)) continue;
      let ev = null;
      if (lead.status === "sent" && lead.ts) {
        if (hasReplied(lead, inbox)) {
          const f = factsForLead(lead, inbox);
          ev = { state: "replied", at: f?.firstReplyMs || lead.ts };
        } else {
          ev = { state: "sent", at: lead.ts };
        }
      } else if (lead.status === "failed") {
        ev = { state: "failed", at: lead.ts || Date.now(), error: lead.error || null };
      }
      if (!ev) continue;
      const prev = best.get(lead.handle);
      if (!prev || RANK[ev.state] > RANK[prev.state]) {
        best.set(lead.handle, { ...ev, handle: lead.handle, prospectId: handles.get(lead.handle), campaign: c.name || null });
      }
    }
  }
  const events = [];
  const next = { ...last };
  for (const [handle, ev] of best) {
    if ((RANK[last[handle]] || 0) >= RANK[ev.state]) continue;
    events.push({ ...ev, at: new Date(ev.at).toISOString() });
    next[handle] = ev.state;
  }
  return { events, next };
}
