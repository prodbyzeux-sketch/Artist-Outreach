// Does a campaign keep its own everything — and does the queue that existed
// before campaigns survive the update?
//
//   node test/campaigns.test.mjs
//
// src/storage.js is the only place that knows a campaign exists: every scoped
// key is written as `base:campaignId`, and the page and the worker both read
// through the same getters. That makes this the one test that matters — two
// campaigns sharing a lead list, or an upgrade that drops the leads someone
// already imported, would both be invisible until it happened to real data.
//
// Each scenario gets its own module instance (the `?n=` cache-buster) because
// the migration is memoised per context, exactly as it is in the page.

const results = [];
const check = (name, pass, extra = "") =>
  results.push(`${pass ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);

// A stub of the three chrome.storage.local calls storage.js makes, over a plain
// object so a scenario can look at the raw keys — which is the whole point when
// what's being tested is which key something landed in.
let fresh_n = 0;
async function fresh(seed = {}) {
  const store = { ...seed };
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => (key in store ? { [key]: store[key] } : {}),
        set: async (obj) => { Object.assign(store, obj); },
        remove: async (key) => { delete store[key]; },
      },
    },
  };
  const mod = await import(`../src/storage.js?n=${++fresh_n}`);
  return { store, ...mod };
}

const lead = (handle) => ({ id: `l_${handle}`, handle, status: "pending" });

// ── the upgrade ───────────────────────────────────────────────────────────────
// Everything anyone had before this feature sits in unscoped keys. It becomes
// campaign one; nothing is left behind and nothing is left in the old place.
{
  const s = await fresh({
    leads: [lead("alice"), lead("bob")],
    messages: [{ id: "m1", text: "hey" }],
    followups: [{ id: "f1", text: "bump" }],
    table: { headers: ["handle"], rows: [["alice"]], fileName: "list.csv" },
    settings: { typingSpeed: 2.5, maxPerRun: 40 },
  });

  const list = await s.getCampaigns();
  check("the data that was there becomes one campaign", list.length === 1, JSON.stringify(list));

  check("  its leads came across", (await s.getLeads()).length === 2);
  check("  its messages came across", (await s.getMessages())[0]?.text === "hey");
  check("  its follow-up steps came across", (await s.getFollowups())[0]?.text === "bump");
  // Back then a campaign had one table, not a list of them — it has to read
  // back as a list of one rather than as nothing at all.
  check("  its table came across", (await s.getTables())[0]?.fileName === "list.csv",
    JSON.stringify(await s.getTables()));
  check("  its settings came across", (await s.getSettings()).typingSpeed === 2.5);
  check("  and defaults still fill the gaps", (await s.getSettings()).perLeadDelayMin === 30000);

  check("nothing is left in the unscoped keys",
    !("leads" in s.store) && !("messages" in s.store) && !("followups" in s.store)
      && !("table" in s.store) && !("settings" in s.store),
    JSON.stringify(Object.keys(s.store)));

  const id = await s.activeCampaignId();
  check("the campaign it made is the active one", !!id && s.store[`leads:${id}`]?.length === 2);
}

// A first-ever install has nothing to bring across, and still gets a campaign:
// every getter downstream assumes there is one.
{
  const s = await fresh();
  check("a fresh install still gets a campaign", (await s.getCampaigns()).length === 1);
  check("  with an empty queue", (await s.getLeads()).length === 0);
  check("  and default settings", (await s.getSettings()).typingSpeed === 1.0);
}

// ── two campaigns are two of everything ───────────────────────────────────────
{
  const s = await fresh({ leads: [lead("alice")], messages: [{ id: "m1", text: "first" }] });
  const first = await s.activeCampaignId();

  const second = await s.createCampaign("Second");
  check("a new campaign is the active one", (await s.activeCampaignId()) === second);
  check("  and starts with no leads", (await s.getLeads()).length === 0);
  check("  and no messages", (await s.getMessages()).length === 0);

  await s.setLeads([lead("carol"), lead("dave"), lead("erin")]);
  await s.setMessages([{ id: "m9", text: "second" }]);
  await s.setSettings({ ...(await s.getSettings()), maxPerRun: 7 });

  await s.setActiveCampaign(first);
  check("the first campaign kept its own leads", (await s.getLeads())[0]?.handle === "alice");
  check("  and its own messages", (await s.getMessages())[0]?.text === "first");
  check("  and its own settings", (await s.getSettings()).maxPerRun === 0);

  await s.setActiveCampaign(second);
  check("the second one kept its three", (await s.getLeads()).length === 3);
  check("  and its cap", (await s.getSettings()).maxPerRun === 7);
}

// How the bot behaves is a preference you set once — a new campaign inherits it
// rather than starting at the defaults, which is the whole difference between
// "another list to write to" and "set the whole thing up again".
{
  const s = await fresh({ settings: { typingSpeed: 3, perLeadDelayMin: 5000, handSkin: "sun" } });
  await s.createCampaign("Second");
  const carried = await s.getSettings();
  check("a new campaign inherits how the bot behaves",
    carried.typingSpeed === 3 && carried.perLeadDelayMin === 5000 && carried.handSkin === "sun",
    JSON.stringify(carried).slice(0, 90));
}

// Names, and the fallback when one isn't given.
{
  const s = await fresh();
  const first = await s.activeCampaignId();
  await s.renameCampaign(first, "Summer outreach");
  check("a campaign can be renamed",
    (await s.getCampaigns()).find((c) => c.id === first)?.name === "Summer outreach");

  await s.createCampaign("");
  const list = await s.getCampaigns();
  check("an unnamed campaign is numbered", list[1].name === "Campaign 2", JSON.stringify(list.map((c) => c.name)));
}

// ── deleting one ──────────────────────────────────────────────────────────────
{
  const s = await fresh({ leads: [lead("alice")] });
  const first = await s.activeCampaignId();
  const second = await s.createCampaign("Second");
  await s.setLeads([lead("carol")]);

  await s.deleteCampaign(second);
  check("deleting the active campaign moves to another", (await s.activeCampaignId()) === first);
  check("  and the one before it is intact", (await s.getLeads())[0]?.handle === "alice");
  check("  and the deleted campaign's data is gone",
    !(`leads:${second}` in s.store) && !(`settings:${second}` in s.store),
    JSON.stringify(Object.keys(s.store)));

  let refused = false;
  try { await s.deleteCampaign(first); } catch { refused = true; }
  check("the last campaign cannot be deleted", refused && (await s.getCampaigns()).length === 1);
}

// A pointer at a campaign that isn't there any more must not take the page down
// with it: storage answers with the first campaign instead.
{
  const s = await fresh();
  await s.set("activeCampaign", "c_gone");
  const id = await s.activeCampaignId();
  check("a dangling active pointer falls back to the first campaign",
    id === (await s.getCampaigns())[0].id, id);
  check("  and reading through it still works", Array.isArray(await s.getLeads()));
}

// ── the per-lead writers are scoped too ───────────────────────────────────────
// updateLead and resetLeadStatuses are what the WORKER calls, once per send. If
// either wrote to the unscoped key the run would look fine and change nothing.
{
  const s = await fresh({ leads: [lead("alice"), lead("bob")] });
  const id = await s.activeCampaignId();

  await s.updateLead("l_alice", { status: "sent", ts: 123 });
  check("updateLead writes into the active campaign",
    s.store[`leads:${id}`].find((l) => l.id === "l_alice").status === "sent" && !("leads" in s.store));

  await s.resetLeadStatuses();
  check("resetLeadStatuses does too",
    s.store[`leads:${id}`].every((l) => l.status === "pending"));
}

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
