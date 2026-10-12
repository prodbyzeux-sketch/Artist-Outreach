// Which lead table the CRM is looking at.
//
// The outreach half scopes a campaign's own keys as `<base>:<campaignId>` and
// migrates the unscoped ones away the first time it runs (outreach/src/storage.js).
// So `leads` alone is never the table — it reads back empty, and an empty table
// is indistinguishable from a campaign nobody has imported yet. That silence is
// why the resolution lives in one tested place instead of a string in the page.

const LEADS = 'leads:';

export const leadsKey = (campaignId) => `${LEADS}${campaignId}`;

/** A storage change worth re-reading the tables for — any campaign's, not just the open one. */
export const isLeadsKey = (key) => String(key).startsWith(LEADS);

/**
 * The campaign the outreach page is on. A pointer at a deleted campaign falls
 * back to the first one — the same rule storage.js applies on the other side,
 * because two answers to "which campaign" would put these numbers on one lead
 * table and the dashboard's on another.
 */
export function activeCampaign(campaigns, activeId) {
  const list = (Array.isArray(campaigns) ? campaigns : []).filter((c) => c?.id);
  if (!list.length) return null;
  return list.find((c) => c.id === activeId) ?? list[0];
}
