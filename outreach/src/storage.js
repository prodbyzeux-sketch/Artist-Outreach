// storage.js — thin async wrappers over chrome.storage.local. All persistent
// state lives here under a few top-level keys.
//
// A campaign owns everything that describes an outreach: who it writes to, what
// it says, and how it behaves. Those keys are stored per campaign as
// `base:campaignId` and reached through the getters below, which resolve the
// active campaign themselves — so the page and the worker keep calling
// getLeads() and neither has to know a campaign exists.

export const KEYS = {
  table: "table",       // [{ headers:[], rows:[[]], matchColumn:int|null, fileName, importedAt }]
  messages: "messages", // [{ id, text }]
  followups: "followups", // [{ id, text }] — ORDERED steps, not variants; see src/followups.js
  leads: "leads",       // [{ id, handle, status, error?, ts?, followers?, posts?,
                        //    followups:[{ ts, stepId, text }] }]
  settings: "settings", // see DEFAULT_SETTINGS
  campaigns: "campaigns",             // [{ id, name, createdAt }] — global, ordered as shown
  activeCampaign: "activeCampaign",   // id of the campaign the page and the worker are on
  runState: "runState",
  humanSeed: "humanSeed", // seeds the human profile in human.js
  inbox: "inbox",         // threadId → derived facts from src/inbox.js (no message text)
  inboxScannedAt: "inboxScannedAt",
  profile: "profile",   // the sending account's own card, refreshed each run
  work: "work",         // { windowId, tabId } — so a resumed worker finds its window
};

// The keys a campaign owns a copy of. Listed rather than derived from KEYS, so
// a key added later is GLOBAL until someone says otherwise: a global key that
// should have been scoped shows up as two campaigns sharing something, while a
// scoped key that should have been global (the inbox, the run) would quietly
// split the record of the account in two.
const SCOPED = [KEYS.table, KEYS.leads, KEYS.messages, KEYS.followups, KEYS.settings];

export const STATUS = {
  pending: "pending",
  sending: "sending",
  sent: "sent",
  failed: "failed",
  skipped: "skipped",
};

// The three delivery paths. Any combination may be enabled; the engine picks one
// at random per lead (mirrors Tabels' enabledFormats).
export const FORMATS = ["justDM", "replyToPost", "replyToStory"];

// The hands that hang over the work window. A skin is a file plus the three
// numbers that describe the artwork, and it lives here rather than in
// src/content/hands.js because the settings page has to list them too and two
// copies of this would drift.
//
//   aspect — width / height of the image
//   seam   — where the empty column between the hands falls, in % across
//   off    — how far off centre each hand hangs, as a fraction of the width
// seam and off are MEASURED from each artwork (the emptiest column between the
// arms, and where the fingertips fall), not inherited: the same numbers on a
// different pair of hands put the clip line through a thumb.
export const HAND_SKINS = [
  { id: "silver", name: "Silver", file: "hands.webp", aspect: 811 / 1181, seam: 50, off: 0.26 },
  { id: "domes", name: "Domes", file: "hands-domes.webp", aspect: 848 / 1248, seam: 47, off: 0.28 },
  { id: "sun", name: "Sun", file: "hands-sun.webp", aspect: 848 / 1248, seam: 48, off: 0.28 },
];

export const handSkin = (id) => HAND_SKINS.find((s) => s.id === id) || HAND_SKINS[0];

export const DEFAULT_SETTINGS = {
  formatJustDM: true,          // ── which send paths are allowed (≥1; picked per lead)
  formatReplyToPost: false,
  formatReplyToStory: false,
  maxPerRun: 0,                // hard cap on sends per run (0 = no cap)
  skipExisting: true,          // skip leads we already have a conversation with (every path)
  // ── the audience filter (src/audience.js) ──
  // Checked before the run walks to a lead, so a lead outside the bounds costs
  // one request and nothing else. Every bound is 0 = no bound, and a filter with
  // no bound set is no filter at all — see audienceFilterOn().
  audienceFilter: false,
  minFollowers: 0, maxFollowers: 0,
  minPosts: 0,                 // a floor only — no ceiling on how much someone posts
  // Pause between leads (ms), random in [min, max].
  perLeadDelayMin: 30000,
  perLeadDelayMax: 90000,
  typingSpeed: 1.0,            // typing-speed multiplier from normal (0.3…4; >1 = faster)
  // ── follow-ups (src/followups.js) ──
  followupsEnabled: false,
  followupAfterHours: 48,      // silence after our last message before the next step is due
  followupMaxPerRun: 0,        // 0 = no cap, and that is the default on purpose
  notifyOnFinish: false,       // desktop notification when a run ends — optional permission
  handSkin: "silver",          // which pair of hands hangs over the work window (HAND_SKINS)
};

// The enabled send paths, with the implicit Just-DM fallback so a run never has none.
export function enabledFormats(settings) {
  const out = FORMATS.filter((f) => settings[`format${f[0].toUpperCase()}${f.slice(1)}`]);
  return out.length ? out : ["justDM"];
}

export const DEFAULT_RUN_STATE = {
  running: false,
  currentIndex: -1,
  consecutiveFailures: 0,   // survives a worker suspension, like the rest of the run
  total: 0,               // first-touch DMs + follow-ups owed when the run started
  sent: 0,
  failed: 0,
  followupTotal: 0,
  followupsSent: 0,
  startedAt: 0,
  stopRequested: false,
  // What the run is doing right now: "opening" | "inbox" | "sending" |
  // "followups". Opening the window and reading the inbox happen before the
  // first lead, and without this the page has nothing to show for that stretch.
  phase: null,
};

export async function get(key, fallback) {
  const obj = await chrome.storage.local.get(key);
  return key in obj ? obj[key] : fallback;
}

export async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

// ── campaigns ─────────────────────────────────────────────────────────────────
// Every scoped getter below goes through activeCampaignId(), so making sure a
// campaign EXISTS has to happen there too — the worker is a service worker that
// is torn down and restarted between leads, so there is no startup to do it in.

// Whatever was in the unscoped keys before campaigns existed becomes campaign
// one — a queue somebody imported and the messages they wrote must not be the
// price of an update. Copy first, then drop the old key: a copy that fails
// leaves the data where the previous version can still read it.
async function migrate() {
  const id = newId("c");
  for (const base of SCOPED) {
    const legacy = await get(base, undefined);
    if (legacy === undefined) continue;
    await set(`${base}:${id}`, legacy);
    await chrome.storage.local.remove(base);
  }
  await set(KEYS.campaigns, [{ id, name: "Campaign 1", createdAt: Date.now() }]);
  await set(KEYS.activeCampaign, id);
}

// Whether a campaign has to be made is answered by READING, not by a flag that
// says it was done once — the page opens by asking for the table, the leads, the
// messages, the follow-ups and the settings at the same time, and five callers
// must not each make themselves a campaign. They share the one migration and
// then read what it made.
let migrating = null;
export async function getCampaigns() {
  const list = await get(KEYS.campaigns, []);
  if (list.length) return list;
  await (migrating ||= migrate().finally(() => { migrating = null; }));
  return await get(KEYS.campaigns, []);
}

// A pointer at a campaign that is gone answers with the first one instead. That
// is not defensive dressing: two pages open, one of them deletes the campaign
// the other is showing, and every read on the second page would throw.
export async function activeCampaignId() {
  const list = await getCampaigns();
  const id = await get(KEYS.activeCampaign, null);
  return list.some((c) => c.id === id) ? id : list[0].id;
}

export async function setActiveCampaign(id) {
  await set(KEYS.activeCampaign, id);
}

// A new campaign starts empty but not unconfigured: it inherits how the bot
// behaves — send paths, pauses, typing speed, the audience bounds — because
// that is a preference you set once, not part of who you are writing to.
export async function createCampaign(name) {
  const list = await getCampaigns();
  const id = newId("c");
  await set(`${KEYS.settings}:${id}`, await getSettings());
  await set(KEYS.campaigns, [...list, { id, name: name || `Campaign ${list.length + 1}`, createdAt: Date.now() }]);
  await setActiveCampaign(id);
  return id;
}

export async function renameCampaign(id, name) {
  const list = await getCampaigns();
  const next = list.map((c) => (c.id === id ? { ...c, name } : c));
  await set(KEYS.campaigns, next);
  return next;
}

export async function deleteCampaign(id) {
  const list = await getCampaigns();
  if (list.length < 2) throw new Error("the last campaign can't be deleted");

  for (const base of SCOPED) await chrome.storage.local.remove(`${base}:${id}`);
  const next = list.filter((c) => c.id !== id);
  await set(KEYS.campaigns, next);
  if ((await get(KEYS.activeCampaign, null)) === id) await setActiveCampaign(next[0].id);
  return next;
}

// ── the campaign's own state ──────────────────────────────────────────────────
const scoped = async (base) => `${base}:${await activeCampaignId()}`;

// The files this campaign writes to, in the order they were added. The key kept
// its name from when only one was allowed, and a table stored back then is
// array-wrapped on the way out rather than migrated — the same one-line
// normalization ui/leads.js does for a lead written before `source` existed.
export async function getTables() {
  const stored = await get(await scoped(KEYS.table), null);
  if (!stored) return [];
  return Array.isArray(stored) ? stored : [stored];
}

export async function setTables(tables) {
  await set(await scoped(KEYS.table), tables);
}

export async function getSettings() {
  const s = await get(await scoped(KEYS.settings), {});
  return { ...DEFAULT_SETTINGS, ...s };
}

export async function setSettings(settings) {
  await set(await scoped(KEYS.settings), settings);
}

export async function getMessages() {
  return await get(await scoped(KEYS.messages), []);
}

export async function setMessages(messages) {
  await set(await scoped(KEYS.messages), messages);
}

// The follow-up steps, in order — including any still being written. Blank ones
// are dropped by src/followups.js, so nothing has to remember to do it here.
export async function getFollowups() {
  return await get(await scoped(KEYS.followups), []);
}

export async function setFollowups(steps) {
  await set(await scoped(KEYS.followups), steps);
}

export async function getLeads() {
  return await get(await scoped(KEYS.leads), []);
}

export async function setLeads(leads) {
  await set(await scoped(KEYS.leads), leads);
}

// One stable seed per browser profile, minted on first run: the same "person"
// (typing speed, tap dwell, how straight they move the mouse) drives every run.
export async function getHumanSeed() {
  const existing = await get(KEYS.humanSeed, null);
  if (existing) return existing;
  const seed = newId("human") + Math.random().toString(36).slice(2);
  await set(KEYS.humanSeed, seed);
  return seed;
}

// Derived reply facts per conversation, keyed by thread id. Never message text:
// the dashboard needs "did they answer and when", not people's DMs.
export async function getInbox() {
  return await get(KEYS.inbox, {});
}

export async function setInbox(facts) {
  await set(KEYS.inbox, facts);
  await set(KEYS.inboxScannedAt, Date.now());
}

// The sending account's own card (handle, name, bio, avatar URL). Refreshed at
// the start of every run: Instagram's avatar URLs are signed and expire, so the
// dashboard falls back to initials rather than showing a broken image.
export async function getProfile() {
  return await get(KEYS.profile, null);
}

export async function setProfile(profile) {
  await set(KEYS.profile, profile);
}

export async function getRunState() {
  const s = await get(KEYS.runState, {});
  return { ...DEFAULT_RUN_STATE, ...s };
}

export async function setRunState(patch) {
  const cur = await getRunState();
  const next = { ...cur, ...patch };
  await set(KEYS.runState, next);
  return next;
}

// Update one lead by id. Returns the updated list.
export async function updateLead(id, patch) {
  const list = await getLeads();
  const next = list.map((l) => (l.id === id ? { ...l, ...patch } : l));
  await setLeads(next);
  return next;
}

// Back to untouched — which has to include the follow-up history, or a lead
// re-sent from here would come back already "done" with three follow-ups it is
// about to be owed again.
export const CLEARED = {
  status: STATUS.pending, error: undefined, ts: undefined,
  followups: undefined, followupsOff: undefined, followupError: undefined,
};

export async function resetLeadStatuses() {
  const list = await getLeads();
  const next = list.map((l) => ({ ...l, ...CLEARED }));
  await setLeads(next);
  return next;
}

// Stable id generator (no crypto dependency needed).
let _idCounter = 0;
export function newId(prefix = "id") {
  _idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${_idCounter}`;
}
