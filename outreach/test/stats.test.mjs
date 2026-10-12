// Do the dashboard's numbers say what happened?
//
//   node test/stats.test.mjs
//
// src/stats.js is pure, so this needs no browser. It exists because of one bug
// that everything else on the page inherited: a lead REMOVED from the queue went
// on being counted, so a list you deleted kept filling the dashboard next to the
// list that replaced it. Removal is a tombstone rather than a splice (a table
// re-import would bring a spliced lead straight back), which is exactly why
// nothing downstream noticed.

import { outcomes, headline, byOpener, byPath, byHour, bestHour, activityGrid, heatLevel, hasReplied }
  from "../src/stats.js";

const results = [];
const check = (name, pass, extra = "") =>
  results.push(`${pass ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);

const HOUR = 3600000;
const NOW = new Date("2026-07-29T15:00:00Z").getTime();

// Two lists, sent a day apart: the old one, then the one that replaced it.
const lead = (id, over) => ({
  id, handle: id, status: "sent", ts: NOW - 24 * HOUR, threadId: `t_${id}`,
  sentMessageId: "m1", format: "justDM", source: "table", ...over,
});
const OLD = [lead("old1"), lead("old2"), lead("old3")];
const NEW = [lead("new1", { ts: NOW - HOUR, sentMessageId: "m2" }), lead("new2", { ts: NOW - HOUR, sentMessageId: "m2" })];
const replied = (lead, at) => ({ [lead.threadId]: { replied: true, firstReplyMs: at, username: lead.handle } });
const INBOX = { ...replied(OLD[0], NOW - 20 * HOUR), ...replied(NEW[0], NOW - 30 * 60000) };

// ── the bug ───────────────────────────────────────────────────────────────────
{
  const both = [...OLD, ...NEW];
  check("with both lists in the queue, both are counted", headline(outcomes(both, INBOX)).sent === 5,
    JSON.stringify(headline(outcomes(both, INBOX))));

  // What deleting the old list actually does to the record.
  const deleted = [...OLD.map((l) => ({ ...l, removed: true })), ...NEW];
  const rows = outcomes(deleted, INBOX);
  const head = headline(rows);
  check("a removed list leaves the headline", head.sent === 2 && head.replied === 1, JSON.stringify(head));
  check("  and the openers", byOpener(rows, [{ id: "m2", text: "hi" }]).every((o) => o.id === "m2"),
    JSON.stringify(byOpener(rows, []).map((o) => `${o.id}:${o.sent}`)));
  check("  and the send paths", byPath(rows).reduce((n, p) => n + p.sent, 0) === 2,
    JSON.stringify(byPath(rows).map((p) => `${p.format}:${p.sent}`)));
  check("  and the hours", byHour(rows).reduce((n, b) => n + b.sent, 0) === 2,
    String(byHour(rows).reduce((n, b) => n + b.sent, 0)));
  check("  and the activity grid", activityGrid(deleted, INBOX, NOW).total === 2,
    JSON.stringify(activityGrid(deleted, INBOX, NOW)).slice(0, 80));

  // Restore is the other half: the tombstone is the only difference between a
  // lead that is gone and one that is back, so its history comes back with it.
  const restored = [...OLD.map((l) => ({ ...l, removed: undefined })), ...NEW];
  check("restoring a removed lead brings its history back",
    headline(outcomes(restored, INBOX)).sent === 5, JSON.stringify(headline(outcomes(restored, INBOX))));
}

// ── one definition of "replied", everywhere ───────────────────────────────────
// A conversation that was already going before we wrote is not somebody
// answering us. outcomes() has always known that; the grid used to count the
// thread's own flag and disagree with every other number on the page.
{
  const old = lead("known", { ts: NOW - 2 * HOUR });
  const inbox = { [old.threadId]: { replied: true, firstReplyMs: NOW - 40 * HOUR, username: "known" } };
  check("a reply that predates our send is not a reply to us", hasReplied(old, inbox) === false);
  check("  the headline agrees", headline(outcomes([old], inbox)).replied === 0);
  check("  and so does the grid", activityGrid([old], inbox, NOW).columns
    .flat().reduce((n, d) => n + d.replied, 0) === 0);
}

// ── the numbers themselves ────────────────────────────────────────────────────
{
  const rows = outcomes([...OLD, ...NEW], INBOX);
  const head = headline(rows);
  check("the rate is replies over sends", head.sent === 5 && head.replied === 2
    && Math.abs(head.rate - 0.4) < 1e-9, JSON.stringify(head));
  // old1 answered 4h after we wrote, new1 after 30min; an even count takes the
  // upper of the two middles.
  check("the median reply lag is measured from OUR send", head.medianReplyLagMs === 4 * HOUR,
    String(head.medianReplyLagMs));

  const openers = byOpener(rows, [{ id: "m1", text: "first" }]);
  check("an opener that was deleted is still named", openers.some((o) => o.text === "(removed variant)"),
    JSON.stringify(openers.map((o) => o.text)));

  check("a best hour is refused until there is a sample",
    bestHour(byHour(rows)).hour === null && /not enough sends/.test(bestHour(byHour(rows)).reason),
    JSON.stringify(bestHour(byHour(rows))));

  const grid = activityGrid([...OLD, ...NEW], INBOX, NOW);
  check("the grid is 53 full weeks ending this one", grid.columns.length === 53
    && grid.columns.every((c) => c.length === 7), `${grid.columns.length} columns`);
  check("  and holds every send", grid.total === 5, String(grid.total));
  check("heat is scaled to the busiest day", heatLevel(0, 3) === 0 && heatLevel(3, 3) === 4,
    `${heatLevel(0, 3)}, ${heatLevel(3, 3)}`);
}

console.log(results.join("\n"));
const ok = results.every((r) => r.startsWith("PASS"));
console.log(ok ? "ALL PASS" : "SOME FAILED");
process.exit(ok ? 0 : 1);
