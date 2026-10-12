// The other half of the extension, read from the CRM's side.
//
// Both halves now share one `chrome.storage.local`, so the CRM can answer the
// question the operator asks before writing anything: did the outreach run
// already message this person, and how did it go? The lead table is the source
// of truth for that; nothing here writes to it.
//
// Matching is EXACT on the handle. A substring match would tell someone they
// already messaged a lead they never touched — the kind of wrong that reads as
// true and changes what they type next.

/** One spelling of a handle, whoever typed it: the table, Instagram, or a person. */
export const handleOf = (value) => String(value ?? '').trim().replace(/^@/, '').toLowerCase();

/** handle → lead. First row wins: a table may list the same handle twice. */
export function indexLeads(leads) {
  const index = new Map();
  for (const lead of Array.isArray(leads) ? leads : []) {
    const handle = handleOf(lead?.handle);
    if (!handle || index.has(handle)) continue;
    index.set(handle, lead);
  }
  return index;
}

export function leadFor(index, username) {
  const handle = handleOf(username);
  if (!handle || !(index instanceof Map)) return null;
  return index.get(handle) ?? null;
}

/**
 * handle → lead, across EVERY campaign's table, each row carrying the campaign
 * it came from. The card asks "have I written to this person", and the answer
 * does not stop being true because the operator has since switched campaigns.
 * First table wins, in the order the outreach page lists them.
 */
export function indexTables(tables) {
  const index = new Map();
  for (const { campaign, leads } of Array.isArray(tables) ? tables : []) {
    for (const lead of Array.isArray(leads) ? leads : []) {
      const handle = handleOf(lead?.handle);
      if (!handle || index.has(handle)) continue;
      index.set(handle, { ...lead, campaign });
    }
  }
  return index;
}

/** The conversations that belong to a lead table — the campaign's own inbox. */
export function threadsForLeads(threads, index) {
  return (Array.isArray(threads) ? threads : []).filter((t) => leadFor(index, t?.username));
}
