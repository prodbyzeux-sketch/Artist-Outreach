// leads.js — the one rule the queue is built on, kept out of the DOM so it can
// be read and tested on its own (src/ui/leads.js draws what this decides).

import { STATUS, newId } from "./storage.js";
import { allHandles } from "./spintax.js";

// The queue is DERIVED from the loaded tables' handle columns, so a lead that
// came from a file cannot simply be spliced out of the array: the next import or
// handle-column change brings it straight back. Everything already known about a
// handle — status, tombstone, what was sent — survives because the existing lead
// object is reused whenever the handle is still there, and pasted leads no table
// mentions are kept as they are.
//
// Across several tables the handles are the UNION (src/spintax.js), which is why
// adding a file adds to the queue and removing one takes only the leads that
// were nowhere else.
export function rebuildLeads(leads, tables) {
  const prev = new Map(leads.map((l) => [l.handle, l]));
  const next = allHandles(tables).map(
    (h) => prev.get(h) || { id: newId("l"), handle: h, source: "table", status: STATUS.pending });
  const inNext = new Set(next.map((l) => l.handle));
  for (const l of leads) if (l.source === "manual" && !inNext.has(l.handle)) next.push(l);
  return next;
}
