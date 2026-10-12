import test from "node:test";
import assert from "node:assert/strict";
import { collectEvents, platformHandles, SOURCE } from "../sync.js";
import { cleanHandle, lookupFollowers } from "../instagram.js";
import { matchColumn, tableHandles, tokenKeys, buildLookup } from "../../outreach/src/spintax.js";
import { rebuildLeads } from "../../outreach/src/leads.js";

// ui/platform.js touches the DOM when used, not when imported; buildTable is pure.
const { buildTable } = await import("../../outreach/src/ui/platform.js");

const prospects = [
  { id: "sp1", handle: "alpha", name: "Alpha", listeners: 1200, igFollowers: 800, reference: "Juice WRLD", spotify: "https://open.spotify.com/artist/sp1" },
  { id: "sp2", handle: "beta.music", name: "Beta", listeners: null, igFollowers: null, reference: null, spotify: null },
];

test("the imported table fits the sender: handle, variables and ao_id", () => {
  const t = buildTable(prospects, { folderName: "Melodic", status: "pending" });
  assert.equal(t.source, SOURCE);
  assert.equal(matchColumn(t), 0);
  assert.deepEqual(tableHandles(t), ["alpha", "beta.music"]);
  assert.deepEqual(tokenKeys(t), ["username", "name", "listeners", "ig_followers", "reference", "spotify", "ao_id"]);
  assert.equal(buildLookup(t).alpha.reference, "Juice WRLD");
  assert.equal(t.fileName, "Artist Outreach · Melodic · not contacted");
  const leads = rebuildLeads([], [t]);
  assert.deepEqual(leads.map((l) => l.handle), ["alpha", "beta.music"]);
});

test("platformHandles only looks at tables from the platform", () => {
  const ao = buildTable(prospects, { folderName: "All", status: "saved" });
  const csv = { headers: ["instagram"], rows: [["gamma"]], matchColumn: 0, fileName: "mine.csv" };
  const m = platformHandles([csv, ao]);
  assert.deepEqual([...m], [["alpha", "sp1"], ["beta.music", "sp2"]]);
});

function world() {
  const table = buildTable(prospects, { folderName: "All", status: "saved" });
  return {
    campaigns: [{ id: "c1", name: "Octubre" }, { id: "c2", name: "Otra" }],
    tables: { c1: [table], c2: [{ headers: ["instagram"], rows: [["alpha"]], matchColumn: 0, fileName: "x.csv" }] },
    leads: {
      c1: [
        { id: "l1", handle: "alpha", status: "sent", ts: Date.parse("2026-10-01T10:00:00Z"), threadId: "t1" },
        { id: "l2", handle: "beta.music", status: "failed", ts: Date.parse("2026-10-01T11:00:00Z"), error: "private account" },
      ],
      // the same person in a campaign that did NOT come from the platform: doesn't count
      c2: [{ id: "l3", handle: "alpha", status: "sent", ts: 1 }],
    },
    inbox: {},
  };
}

test("collectEvents: sent and failed, once", () => {
  const w = world();
  const { events, next } = collectEvents({ ...w, last: {} });
  assert.deepEqual(events.map((e) => [e.handle, e.state, e.prospectId, e.campaign]), [
    ["alpha", "sent", "sp1", "Octubre"],
    ["beta.music", "failed", "sp2", "Octubre"],
  ]);
  assert.equal(events[0].at, "2026-10-01T10:00:00.000Z");
  assert.equal(events[1].error, "private account");
  // second pass with no changes: nothing to send
  assert.deepEqual(collectEvents({ ...w, last: next }).events, []);
});

test("collectEvents: a reply after the send moves it to replied", () => {
  const w = world();
  const { next } = collectEvents({ ...w, last: {} });
  w.inbox = { t1: { username: "alpha", replied: true, firstReplyMs: Date.parse("2026-10-02T09:00:00Z") } };
  const { events } = collectEvents({ ...w, last: next });
  assert.deepEqual(events.map((e) => [e.handle, e.state, e.at]), [["alpha", "replied", "2026-10-02T09:00:00.000Z"]]);
});

test("collectEvents: pending, removed and backwards moves are not sent", () => {
  const w = world();
  w.leads.c1 = [
    { id: "l1", handle: "alpha", status: "pending" },
    { id: "l2", handle: "beta.music", status: "sent", ts: 5, removed: true },
  ];
  assert.deepEqual(collectEvents({ ...w, last: {} }).events, []);
  w.leads.c1 = [{ id: "l1", handle: "alpha", status: "sent", ts: 5 }];
  assert.deepEqual(collectEvents({ ...w, last: { alpha: "replied" } }).events, []);
});

test("cleanHandle", () => {
  assert.equal(cleanHandle("@Foo.Bar"), "foo.bar");
  assert.equal(cleanHandle("bad/handle"), null);
  assert.equal(cleanHandle(""), null);
});

test("lookupFollowers: reads, stops on 429 and stays out of a running send", async () => {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(url).searchParams.get("username");
    seen.push({ u, creds: init.credentials, app: init.headers["X-IG-App-ID"] });
    if (u === "limit") return new Response("", { status: 429 });
    return new Response(JSON.stringify({ data: { user: { edge_followed_by: { count: u.length * 100 } } } }), { status: 200 });
  };
  try {
    const busy = await lookupFollowers(["abc"], { isBusy: async () => true });
    assert.deepEqual(busy, { results: {}, error: "busy" });
    assert.equal(seen.length, 0);

    const r = await lookupFollowers(["abc", "@abcd", "bad/x"]);
    assert.deepEqual(r.results, { abc: 300, abcd: 400 });
    assert.ok(seen.every((s) => s.creds === "include" && s.app));

    const r2 = await lookupFollowers(["limit"]);
    assert.equal(r2.error, "rate_limited");
    const r3 = await lookupFollowers(["zzz"]);
    assert.deepEqual(r3, { results: {}, error: "rate_limited" });
  } finally {
    globalThis.fetch = real;
  }
});

test("quota: messages say what to do", async () => {
  const { explain, describeQuota } = await import("../quota.js");
  assert.match(explain("not_connected"), /Connect your Artist Outreach account/);
  assert.match(explain("daily_limit", { limit: 10 }), /today's 10 automated DMs.*upgrade to Pro/i);
  assert.match(explain("subscription_required"), /plan isn't active/);
  assert.equal(describeQuota({ plan: "starter", limit: 10, remaining: 3, used: 7 }), "Starter plan · 3 of 10 automated DMs left today");
  assert.match(describeQuota({ plan: "pro", limit: null, used: 12 }), /unlimited/);
});
