// Tags: the operator's own labels on a lead. Free-form on purpose — a fixed list
// is what the funnel stage is for.
//
// Both functions return the SAME array when nothing changed, so the caller can
// skip a write instead of asking the store to work out that nothing moved.

const MAX_LENGTH = 24;

const clean = (raw) => String(raw ?? '')
  .replace(/^[#\s]+/, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, MAX_LENGTH)
  .trim();

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/** One field, one or more tags: `usa, trap` is two of them. */
export function addTags(tags = [], input) {
  const current = Array.isArray(tags) ? tags : [];
  const next = [...current];
  for (const part of String(input ?? '').split(',')) {
    const tag = clean(part);
    if (!tag || next.some((existing) => same(existing, tag))) continue;
    next.push(tag);
  }
  return next.length === current.length ? tags ?? [] : next;
}

export function removeTag(tags = [], tag) {
  const current = Array.isArray(tags) ? tags : [];
  const next = current.filter((existing) => !same(existing, String(tag ?? '')));
  return next.length === current.length ? tags ?? [] : next;
}

/**
 * A whole list arriving from outside the page — the bridge. Cleaned by the rules
 * above, or `null` if it isn't a list of strings: coercing `42` into something
 * would hand the sender a success for a write they never asked for, and a tag
 * list that isn't one is what breaks every later render of the list.
 */
export function normalizeTags(value) {
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== 'string')) return null;
  const out = [];
  for (const raw of value) {
    const tag = clean(raw);
    if (tag && !out.some((existing) => same(existing, tag))) out.push(tag);
  }
  return out;
}
