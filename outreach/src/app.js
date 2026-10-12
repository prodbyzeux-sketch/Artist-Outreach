// app.js — the full-page UI's composition root: load state, hand each section
// its slice, and route the worker's messages. Everything with behaviour lives in
// src/ui/*; this file only wires.

import {
  getTables, getSettings, getMessages, getFollowups, getLeads, getInbox,
  setTables, setLeads, setMessages, setFollowups, setSettings,
} from "./storage.js";
import { initTables, setTablesLocked, currentTables } from "./ui/tables.js";
import { initLeads, rebuildFromTables, refreshLead, replaceLeads, setLocked as lockQueue, setFollowupContext, allLeads }
  from "./ui/leads.js";
import { initMessages, insertToken, renderMessagePreview, allMessages } from "./ui/messages.js";
import { initFollowups, renderFollowupPreview, allFollowups } from "./ui/followups.js";
import { initSettings, currentSettings, setMaxPerRun } from "./ui/settings.js";
import { initCampaigns, setCampaignsLocked } from "./ui/campaigns.js";
import { initRun, updateRunUI, appendLog } from "./ui/run.js";
import { initDashboard, renderDashboard, setRefreshing } from "./ui/dashboard.js";
import { initPlatform } from "./ui/platform.js";

// A run owns the queue it is working, the files that fill it, and the campaign
// all of it belongs to.
const setLocked = (running) => { lockQueue(running); setTablesLocked(running); setCampaignsLocked(running); };

// The follow-up column and the monitor above the queue read the steps, the
// reply facts and the settings — none of which belong to the Leads section. Any
// of the three moving re-draws the queue.
const pushFollowupContext = async () =>
  setFollowupContext({ steps: allFollowups(), settings: currentSettings(), inbox: await getInbox() });

// Everything the page is holding, written back to the campaign it belongs to.
// The sections save as you type, but on a debounce — and switching campaigns
// reloads the page out from under those timers.
const commitCurrent = () => Promise.all([
  setTables(currentTables()), setLeads(allLeads()), setMessages(allMessages()),
  setFollowups(allFollowups()), setSettings(currentSettings()),
]);

async function init() {
  const [tables, settings, messages, followups, leads] = await Promise.all([
    getTables(), getSettings(), getMessages(), getFollowups(), getLeads(),
  ]);

  initLeads(leads, { log: appendLog });
  initTables(tables, {
    // The files decide who is in the queue, and the previews render the first
    // lead's row — so both follow every import, removal and column change.
    onChanged: () => {
      rebuildFromTables(currentTables());
      renderMessagePreview();
      renderFollowupPreview();
    },
    insertToken,
  });
  initMessages(messages, currentTables);
  initFollowups(followups, currentTables, pushFollowupContext);
  initSettings(settings, pushFollowupContext);
  await initCampaigns({ commitCurrent });
  await initRun({
    messages: allMessages, leads: allLeads,
    settings: currentSettings, setLimit: setMaxPerRun, onRunningChanged: setLocked,
  });
  initDashboard();
  initPlatform();
  await pushFollowupContext();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === "LOG") appendLog(msg.text, msg.level);
  else if (msg.type === "PROGRESS") updateRunUI(msg.state, setLocked);
  else if (msg.type === "PROFILE_CHANGED") renderDashboard();
  else if (msg.type === "INBOX_CHANGED") { renderDashboard(); pushFollowupContext(); }
  else if (msg.type === "INBOX_REFRESH") setRefreshing(msg.busy);
  else if (msg.type === "LEADS_CHANGED") {
    // One lead at a time during a run: patching its row beats rebuilding a list
    // that can be thousands of rows long, once per send.
    if (msg.lead) refreshLead(msg.lead);
    else getLeads().then(replaceLeads);
    renderDashboard();          // a lead moving changes the numbers above it
  }
});

init();
