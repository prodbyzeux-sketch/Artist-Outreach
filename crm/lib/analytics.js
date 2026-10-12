// The campaign, in numbers — the CRM's side of the run.
//
// The reply rate comes from the outreach half's own stats module rather than a
// second implementation here: "did they answer us" is a definition with edges
// (an inbound BEFORE our send is not an answer), and the dashboard and this
// panel disagreeing about it would be a bug nobody could see.

import { outcomes, headline } from '../../outreach/src/stats.js';
import { countByStage } from './stages.js';
import { handleOf } from './outreach.js';

/**
 * `threads` are the campaign's conversations — the ones already matched to the
 * lead table, not the whole inbox.
 *
 * `scanned` says whether the inbox has ever been read. Without it the reply
 * numbers come back null instead of zero: "nobody answered" and "nobody has
 * looked" are different claims, and printing the first when the second is true
 * is the kind of wrong that gets acted on.
 */
export function campaignStats({ leads = [], inbox = {}, threads = [], scanned = false } = {}) {
  const live = (Array.isArray(leads) ? leads : []).filter((lead) => lead && !lead.removed);
  const rows = outcomes(live, inbox ?? {});
  const head = headline(rows);

  const present = new Set((threads ?? []).map((t) => handleOf(t.username)).filter(Boolean));

  return {
    leads: live.length,
    sent: head.sent,
    replied: scanned ? head.replied : null,
    rate: scanned ? head.rate : null,
    medianReplyLagMs: scanned ? head.medianReplyLagMs : null,
    // Instagram hands back the recent threads, not all of them, so most of a
    // long campaign has no conversation here. Saying how many do is the
    // difference between "the capture is partial" and "the campaign did nothing".
    captured: rows.filter((r) => present.has(handleOf(r.lead.handle))).length,
    stages: countByStage(threads),
    threads: (threads ?? []).length,
  };
}

/** The one line the panel shows while it is folded shut. */
export function statHeadline(stats) {
  const parts = [`${stats.leads} ${stats.leads === 1 ? 'lead' : 'leads'}`, `${stats.sent} sent`];
  parts.push(stats.replied === null
    ? 'replies not read yet'
    : `${stats.replied} replied · ${Math.round(stats.rate * 100)}%`);
  return parts.join(' · ');
}

const MINUTE = 60000, HOUR = 3600000, DAY = 86400000;

/** How long people take to answer, in the unit somebody would say it in. */
export function duration(ms) {
  if (!ms) return '—';
  if (ms < MINUTE) return 'under a minute';
  if (ms < HOUR) return `${Math.round(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.round(ms / HOUR)}h`;
  return `${Math.round(ms / DAY)}d`;
}
