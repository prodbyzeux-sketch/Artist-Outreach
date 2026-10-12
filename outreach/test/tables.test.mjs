// Several tables are one audience — and adding one must never take the previous
// one's leads with it.
//
//   node test/tables.test.mjs
//
// Pure functions over plain objects, so this needs no browser and no stubs. It
// covers the rule the whole Leads section rests on: the queue is DERIVED from
// the loaded tables, so what "derived" means across more than one file is the
// difference between a second import adding to the list and replacing it.

import { allHandles, allTokenKeys, mergedLookup } from "../src/spintax.js";
import { rebuildLeads } from "../src/leads.js";

const results = [];
const check = (name, pass, extra = "") =>
  results.push(`${pass ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);

const table = (fileName, headers, rows) => ({ fileName, headers, rows, matchColumn: null });

const A = table("artists.csv", ["instagram", "name"], [["alice", "Alice"], ["bob", "Bob"]]);
const B = table("berlin.csv", ["instagram", "city"], [["carol", "Berlin"], ["bob", "Wien"]]);

const handles = (leads) => leads.map((l) => l.handle);
const find = (leads, handle) => leads.find((l) => l.handle === handle);

// ── the union ─────────────────────────────────────────────────────────────────
check("one table is its own handles", allHandles([A]).join() === "alice,bob", allHandles([A]).join());
check("two tables are both, in the order they were added",
  allHandles([A, B]).join() === "alice,bob,carol", allHandles([A, B]).join());
check("  a handle in both is listed once", allHandles([A, B]).filter((h) => h === "bob").length === 1);
check("no tables are no handles", allHandles([]).length === 0);
check("a missing list is not a crash", allHandles(undefined).length === 0);

// ── the variables ─────────────────────────────────────────────────────────────
check("every table's columns become variables",
  allTokenKeys([A, B]).join() === "username,name,city", allTokenKeys([A, B]).join());
check("  and {username} is there with no table at all", allTokenKeys([]).join() === "username");

// ── the lookup ────────────────────────────────────────────────────────────────
const lookup = mergedLookup([A, B]);
check("a lead's row comes from the table it is in", lookup.alice?.name === "Alice" && lookup.carol?.city === "Berlin",
  JSON.stringify(lookup));
check("a handle in two tables takes the first one's row",
  lookup.bob?.name === "Bob" && lookup.bob?.city === undefined, JSON.stringify(lookup.bob));

// ── the queue the tables add up to ────────────────────────────────────────────
// The complaint this whole file exists for: a second file used to replace the
// first, and every lead that came from it — statuses and all — went with it.
{
  const sent = { id: "l_alice", handle: "alice", source: "table", status: "sent", ts: 1700000000000 };
  const pasted = { id: "l_dave", handle: "dave", source: "manual", status: "pending" };

  const one = rebuildLeads([sent, pasted], [A]);
  check("the first table fills the queue", handles(one).join() === "alice,bob,dave", handles(one).join());
  check("  without disturbing what is already known about a lead", find(one, "alice").status === "sent");

  const two = rebuildLeads(one, [A, B]);
  check("a second table ADDS to the queue", handles(two).join() === "alice,bob,carol,dave", handles(two).join());
  check("  the first table's leads stay", find(two, "alice").status === "sent" && !!find(two, "bob"));
  check("  the pasted ones stay too", find(two, "dave").source === "manual");
  check("  and the new rows arrive pending", find(two, "carol").status === "pending");

  const back = rebuildLeads(two, [B]);
  check("removing a table takes only the leads that were only in it",
    handles(back).join() === "carol,bob,dave", handles(back).join());
  check("  a handle the other table also lists keeps everything it had",
    find(back, "bob").id === find(two, "bob").id);
}

// A removed lead is a tombstone, not a gap: re-importing the file it came from
// must not put it back in the queue.
{
  const removed = { id: "l_bob", handle: "bob", source: "table", status: "pending", removed: true };
  const next = rebuildLeads([removed], [A, B]);
  check("a removed lead stays removed through an import", find(next, "bob").removed === true);
}

// ── report ────────────────────────────────────────────────────────────────────
console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
