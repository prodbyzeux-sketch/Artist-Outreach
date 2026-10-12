// Which rows a click leaves selected.
//
// Three gestures, one function: a plain click is not a pick and collapses the
// selection, a modifier click toggles one row, and shift takes the run between
// the anchor and the row. Pure on purpose — the modifier rules are exactly where
// this kind of thing goes wrong, and a browser is a poor place to find out.

/**
 * `ids` is the list AS SHOWN: a run is what the eye sees between two rows, so it
 * has to be counted over the filtered order and not over the whole inbox.
 *
 * A run ADDS to the selection rather than replacing it. Building a selection out
 * of two runs from opposite ends of the list is ordinary, and the alternative
 * costs the first one every time.
 */
export function nextPick({ picked, anchor, ids, id, mode }) {
  if (mode === 'range') {
    const from = ids.indexOf(anchor);
    const to = ids.indexOf(id);
    // No anchor, or one that has since left the list: this is the start of a run
    // rather than a gesture that does nothing.
    if (from === -1 || to === -1) return { picked: new Set([...picked, id]), anchor: id };
    const run = from < to ? ids.slice(from, to + 1) : ids.slice(to, from + 1);
    return { picked: new Set([...picked, ...run]), anchor };
  }

  if (mode === 'toggle') {
    const next = new Set(picked);
    if (!next.delete(id)) next.add(id);
    return { picked: next, anchor: id };
  }

  return { picked: new Set(), anchor: id };
}

/** The same set back when every pick is still on screen, so nothing repaints. */
export function prunePicked(picked, ids) {
  const shown = new Set(ids);
  const kept = [...picked].filter((id) => shown.has(id));
  return kept.length === picked.size ? picked : new Set(kept);
}
