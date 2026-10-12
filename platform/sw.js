// platform/sw.js — the service-worker side of the Artist Outreach platform.
//
//   ao-hello      the web app asks whether the extension is connected, and to whom
//   ao-pair       the web app hands over its account token ("Connect extension")
//   ao-ig-lookup  the web app asks for Instagram follower counts read in this browser
//   alarm ao-sync every 2 min: states of imported campaigns → platform
//
// It only answers `ao-*` messages, and only from the origins in config.js; the
// other protocols (the run's SCREAMING_CASE, the inbox's crm-*) are untouched.

import { isPlatformOrigin } from "./config.js";
import { getConnection, setConnection, me, postEvents, PlatformError } from "./api.js";
import { lookupFollowers } from "./instagram.js";
import { collectEvents } from "./sync.js";

const SYNC_ALARM = "ao-sync";
const SYNC_KEY = "aoSync";

const senderOrigin = (sender) => {
  try { return sender?.origin || new URL(sender?.url || "").origin; } catch (_) { return null; }
};

// While a send run is going, the Instagram account belongs to it: no extra lookups.
async function runIsBusy() {
  const { runState } = await chrome.storage.local.get("runState");
  return !!runState?.running;
}

async function handle(msg, sender) {
  const origin = senderOrigin(sender);
  // Messages from the web app arrive through bridge.js (a content script) and
  // carry their tab; nothing else is accepted here.
  if (!sender?.tab || !isPlatformOrigin(origin) || msg.origin !== origin) {
    return { error: "origin not allowed" };
  }

  if (msg.type === "ao-hello") {
    const c = await getConnection();
    const sameServer = c && c.origin === origin;
    return { paired: !!sameServer, email: sameServer ? c.email : null, version: chrome.runtime.getManifest().version };
  }

  if (msg.type === "ao-pair") {
    if (typeof msg.token !== "string" || msg.token.length < 20) return { ok: false, error: "bad token" };
    const conn = { origin, token: msg.token };
    try {
      const r = await me(conn);
      await setConnection({ ...conn, email: r.user?.email || null, pairedAt: Date.now() });
      scheduleSync();
      return { ok: true, email: r.user?.email || null };
    } catch (e) {
      return { ok: false, error: e instanceof PlatformError ? e.message : String(e?.message || e) };
    }
  }

  if (msg.type === "ao-ig-lookup") {
    const usernames = Array.isArray(msg.usernames) ? msg.usernames : [];
    return lookupFollowers(usernames, { isBusy: runIsBusy });
  }

  return { error: "unknown" };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("ao-")) return false;
  handle(msg, sender).then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});

// ── sync ─────────────────────────────────────────────────────────────────────
function readCampaignStorage(all) {
  const campaigns = Array.isArray(all.campaigns) ? all.campaigns : [];
  const tables = {}, leads = {};
  for (const c of campaigns) {
    tables[c.id] = all[`table:${c.id}`] || [];
    leads[c.id] = all[`leads:${c.id}`] || [];
  }
  return { campaigns, tables, leads, inbox: all.inbox || {} };
}

let syncing = null;
export async function syncNow() {
  if (syncing) return syncing;
  syncing = (async () => {
    const conn = await getConnection();
    if (!conn) return { skipped: "not_connected" };
    const all = await chrome.storage.local.get(null);
    const last = all[SYNC_KEY] || {};
    const { events, next } = collectEvents({ ...readCampaignStorage(all), last });
    if (!events.length) return { sent: 0 };
    let sent = 0;
    for (let i = 0; i < events.length; i += 200) {
      const chunk = events.slice(i, i + 200);
      await postEvents(chunk);
      sent += chunk.length;
      // Saved per batch: if the network drops halfway, what went out isn't repeated.
      const done = { ...last };
      for (const ev of events.slice(0, i + chunk.length)) done[ev.handle] = next[ev.handle];
      await chrome.storage.local.set({ [SYNC_KEY]: done });
    }
    return { sent };
  })().catch((e) => ({ error: String(e?.message || e) })).finally(() => { syncing = null; });
  return syncing;
}

function scheduleSync() {
  chrome.alarms.get(SYNC_ALARM).then((a) => {
    if (!a) chrome.alarms.create(SYNC_ALARM, { delayInMinutes: 0.5, periodInMinutes: 2 });
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) syncNow();
});
chrome.runtime.onInstalled.addListener(scheduleSync);
chrome.runtime.onStartup.addListener(scheduleSync);
