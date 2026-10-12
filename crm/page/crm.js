// The CRM tab: state, messages to the service worker, events. What things look
// like lives in view.js.

import {
  sinceLabel, clockTime, humanError, paragraph, bubble, avatar, option,
  leadSummary, outreachLine, statGrid, funnelBar,
} from './view.js';
import { createQueue } from './queue.js';
import { PIPELINE, OUTCOMES, stageIndex, stageOf } from '../lib/stages.js';
import {
  dayInputToMs, msToDayInput, plusDays, followUpLabel, isDue, stageAgeDays,
} from '../lib/followup.js';
import { FOLDERS_KEY, folderOf } from '../lib/folders.js';
import { addTags, removeTag } from '../lib/tags.js';
import { indexLeads, indexTables, leadFor, threadsForLeads } from '../lib/outreach.js';
import { activeCampaign, leadsKey, isLeadsKey } from '../lib/campaign.js';
import { campaignStats, statHeadline } from '../lib/analytics.js';
import { createDrafts } from '../lib/drafts.js';
import { AVATARS_KEY } from '../lib/avatars.js';
import { startBridge } from './bridge.js';

const NOTE_SAVE_MS = 600;
/** Which conversations are on screen and whether the campaign panel is open. */
const VIEW_KEY = 'crmView';
// A load that fails on the first try and works on the second is the normal way a
// sleeping service worker wakes up. Reporting it instantly makes the page flash
// a red band on nearly every open, so a background failure has to still be true
// after this long before it is worth the user's attention.
const BAND_DELAY_MS = 6000;

const el = {
  account: document.getElementById('account'),
  sync: document.getElementById('sync'),
  refresh: document.getElementById('refresh'),
  backfill: document.getElementById('backfill'),
  band: document.getElementById('band'),
  bandText: document.getElementById('band-text'),
  bandAction: document.getElementById('band-action'),
  stats: document.getElementById('stats'),
  statsToggle: document.getElementById('stats-toggle'),
  statsName: document.getElementById('stats-name'),
  statsLine: document.getElementById('stats-line'),
  statsBody: document.getElementById('stats-body'),
  statsGrid: document.getElementById('stats-grid'),
  funnel: document.getElementById('funnel'),
  modes: document.getElementById('modes'),
  emptyAction: document.getElementById('empty-action'),
  cardPlaceholder: document.getElementById('card-placeholder'),
  card: document.getElementById('card'),
  lead: document.getElementById('lead'),
  leadAvatar: document.getElementById('lead-avatar'),
  leadName: document.getElementById('lead-name'),
  leadHandle: document.getElementById('lead-handle'),
  leadSummary: document.getElementById('lead-summary'),
  leadOutreach: document.getElementById('lead-outreach'),
  stages: document.getElementById('stages'),
  outcomes: document.getElementById('outcomes'),
  folderField: document.getElementById('folder-field'),
  folderOf: document.getElementById('folder-of'),
  note: document.getElementById('note'),
  tags: document.getElementById('tags'),
  tagInput: document.getElementById('tag-input'),
  threadPlaceholder: document.getElementById('thread-placeholder'),
  thread: document.getElementById('thread'),
  compose: document.getElementById('compose'),
  composeText: document.getElementById('compose-text'),
  composeSend: document.getElementById('compose-send'),
  linked: document.getElementById('linked'),
  bridge: document.getElementById('bridge'),
  stageAge: document.getElementById('stage-age'),
  followUp: document.getElementById('follow-up'),
  followUpClear: document.getElementById('follow-up-clear'),
  followUpPresets: document.getElementById('follow-up-presets'),
  followUpNote: document.getElementById('follow-up-note'),
};

let threads = [];
let selectedID = null;
let refreshing = false;
/** Where conversations can be filed. The queue column browses them; the card files one. */
let folders = [];
/** 'campaign' — only the open campaign's leads; 'all' — the whole inbox. */
let mode = 'all';
let statsOpen = false;
/** The thread whose note the textarea currently holds — a save must not land on another. */
let noteThreadID = null;
/** Replies started and not sent, by thread. One composer, many conversations. */
const drafts = createDrafts();
let noteTimer = null;
let bandTimer = null;

// ── The outreach half, read only ──────────────────────────────────────────
// The lead table is per campaign (`leads:<id>`), the inbox facts are not. Every
// table stays in memory so a run — which rewrites one of them several times a
// second — repaints from an object instead of from storage.
let campaigns = [];
let campaign = null;
let tables = {};
/** handle → lead, across all campaigns: what the card asks. */
let allLeads = new Map();
/** handle → lead, the open campaign only: what the list and the numbers ask. */
let leads = new Map();
let leadList = [];
let inbox = {};
let inboxScanned = false;
/** Replies in flight — ghost bubbles until Instagram's own copy comes back. */
let pending = [];
let pendingSeq = 0;
/**
 * Profile pictures the worker has kept, by IG user id. Read once and then only
 * when they change: this is the one thing in storage measured in megabytes, and
 * `load` runs on every capture.
 */
let pictures = {};

const send = (message) => chrome.runtime.sendMessage(message);

// ── Rendering ─────────────────────────────────────────────────────────────

/** The conversations the current mode is about, before search and stage filter. */
const inScope = () => (mode === 'campaign' && campaign ? threadsForLeads(threads, leads) : threads);

/** Everything the queue column paints from. It owns the rest of what it shows. */
function paintQueue() {
  queue.render({
    all: threads,
    scope: inScope(),
    folders,
    selectedID,
    pictures,
    campaignOnly: mode === 'campaign' && Boolean(campaign),
  });
}

/**
 * The campaign panel. Present only in campaign mode — in the whole inbox these
 * numbers would be about a slice of what is on screen, which is worse than
 * absent. Folded shut it is one line; the grid is built only when it is open.
 */
function renderStats() {
  const showing = mode === 'campaign' && Boolean(campaign);
  el.stats.hidden = !showing;
  if (!showing) return;

  const stats = campaignStats({ leads: leadList, inbox, threads: inScope(), scanned: inboxScanned });
  el.statsName.textContent = campaign.name;
  el.statsLine.textContent = statHeadline(stats);
  el.statsToggle.setAttribute('aria-expanded', String(statsOpen));
  el.statsBody.hidden = !statsOpen;
  if (!statsOpen) return;
  el.statsGrid.replaceChildren(statGrid(stats));
  el.funnel.replaceChildren(funnelBar(stats.stages));
}

/** No campaign imported, no switch: an empty toggle is furniture for nothing. */
function renderModes() {
  el.modes.hidden = !campaign;
  for (const button of el.modes.children) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  }
}

/**
 * Who the conversation is with, over the conversation itself. The card next
 * door holds the controls and repeats none of this — a name in two columns is
 * one name too many in a window this narrow.
 */
function renderLeadHead() {
  const thread = threads.find((t) => t.threadID === selectedID);
  el.lead.hidden = !thread;
  if (!thread) return;

  el.leadAvatar.replaceChildren(avatar(thread, pictures));
  el.leadName.textContent = thread.displayName || thread.username || 'no name';
  el.leadHandle.hidden = !thread.username;
  if (thread.username) {
    el.leadHandle.textContent = `@${thread.username}`;
    el.leadHandle.href = `https://www.instagram.com/${encodeURIComponent(thread.username)}/`;
  }
  el.leadSummary.textContent = leadSummary(thread);

  // The same person in a send run's lead table, if they are in one — any of
  // them. The campaign is named only when it is not the one on screen, where it
  // would repeat the panel above.
  const lead = leadFor(allLeads, thread.username);
  el.leadOutreach.hidden = !lead;
  if (lead) {
    const elsewhere = lead.campaign && lead.campaign.id !== campaign?.id ? lead.campaign.name : '';
    el.leadOutreach.textContent = [outreachLine(lead), elsewhere].filter(Boolean).join(' · ');
    el.leadOutreach.dataset.status = lead.status ?? '';
    el.leadOutreach.title = lead.error ? `Outreach error: ${lead.error}` : '';
  }
}

function renderCard() {
  const thread = threads.find((t) => t.threadID === selectedID);
  el.card.hidden = !thread;
  el.cardPlaceholder.hidden = Boolean(thread);
  if (!thread) return;

  // The track carries a position, so it also carries the ground covered to get
  // there. A conversation that has stopped has no position on it: nothing is
  // marked, which says so without dimming controls you may still want to press
  // to pull a lead back out of Lost.
  const stage = stageOf(thread);
  const reached = stageIndex(stage);
  for (const step of el.stages.children) {
    const at = stageIndex(step.dataset.stage);
    step.setAttribute('aria-pressed', String(step.dataset.stage === stage));
    step.dataset.passed = String(reached > -1 && at < reached);
  }
  for (const button of el.outcomes.children) {
    button.setAttribute('aria-pressed', String(button.dataset.stage === stage));
  }

  // A capture repaints the card at any moment; typing must survive that.
  if (document.activeElement !== el.note || noteThreadID !== thread.threadID) {
    el.note.value = thread.note ?? '';
    noteThreadID = thread.threadID;
  }

  renderFolderField(thread);

  const tags = Array.isArray(thread.tags) ? thread.tags : [];
  el.tags.hidden = tags.length === 0;
  el.tags.replaceChildren(...tags.map((tag) => chip(String(tag), thread.threadID)));

  const age = stageAgeDays(thread);
  el.stageAge.hidden = age === null;
  el.stageAge.textContent = age === null ? '' : `${age} ${age === 1 ? 'day' : 'days'} here`;

  // A date field being typed into must not be yanked around by a capture, the
  // same rule the note lives by.
  if (document.activeElement !== el.followUp) el.followUp.value = msToDayInput(thread.followUpAt);
  el.followUpClear.hidden = !thread.followUpAt;
  el.followUpNote.hidden = !thread.followUpAt;
  el.followUpNote.textContent = followUpLabel(thread.followUpAt);
  el.followUpNote.dataset.due = String(isDue(thread));
}

/**
 * Where this one lead is filed. Absent until a folder exists — a select whose
 * only answer is "No folder" is a control for nothing.
 *
 * The options are rebuilt only when the folders themselves change: a capture
 * repaints the card at any moment, and rebuilding a select the user has open
 * closes it under their hand.
 */
function renderFolderField(thread) {
  el.folderField.hidden = folders.length === 0;
  if (!folders.length) return;
  const built = folders.map((f) => `${f.id}:${f.name}`).join('|');
  if (el.folderOf.dataset.built !== built) {
    el.folderOf.replaceChildren(option('', 'No folder'), ...folders.map((f) => option(f.id, f.name)));
    el.folderOf.dataset.built = built;
  }
  if (document.activeElement !== el.folderOf) el.folderOf.value = folderOf(thread, folders);
}

/** Both halves of "who is on screen": they answer to the same selection. */
function renderSelected() {
  renderLeadHead();
  renderCard();
}

/** A tag with its own way out. The × is a button, so it is reachable by keyboard. */
function chip(tag, threadID) {
  const span = document.createElement('span');
  span.className = 'tag';
  span.textContent = tag;
  const drop = document.createElement('button');
  drop.className = 'tag-drop';
  drop.type = 'button';
  drop.textContent = '×';
  drop.title = `Remove ${tag}`;
  drop.setAttribute('aria-label', `Remove tag ${tag}`);
  drop.addEventListener('click', () => {
    const thread = threads.find((t) => t.threadID === threadID);
    const next = removeTag(thread?.tags, tag);
    if (thread && next !== thread.tags) patch(threadID, { tags: next });
  });
  span.append(drop);
  return span;
}

async function renderThread() {
  const thread = threads.find((t) => t.threadID === selectedID);
  if (!thread) {
    el.threadPlaceholder.replaceChildren(paragraph('Pick a conversation on the left.'));
    el.thread.hidden = true;
    el.threadPlaceholder.hidden = false;
    el.compose.hidden = true;
    return;
  }
  el.compose.hidden = false;
  const messages = await send({ type: 'crm-messages', threadID: thread.threadID });

  // Drop ghosts whose real copy has come back from Instagram.
  const outTexts = new Set((messages ?? []).filter((m) => m.direction === 'out').map((m) => m.text));
  pending = pending.filter((p) => p.threadID !== thread.threadID || !outTexts.has(p.text));
  const mine = pending.filter((p) => p.threadID === thread.threadID);

  if (!messages?.length && !mine.length) {
    // Selected, but nothing captured for it yet — say so instead of showing a
    // blank column that looks like the app broke.
    el.threadPlaceholder.replaceChildren(
      paragraph('Messages arrive once the linked tab opens this conversation. Or press Refresh.'),
    );
    el.thread.hidden = true;
    el.threadPlaceholder.hidden = false;
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const m of messages ?? []) fragment.append(bubble(m.text, m.direction, clockTime(m.timestamp)));
  for (const p of mine) fragment.append(bubble(p.text, 'out', 'sending…', 'pending'));
  el.thread.replaceChildren(fragment);
  el.thread.hidden = false;
  el.threadPlaceholder.hidden = true;
  el.thread.scrollTop = el.thread.scrollHeight;
}

function renderHeader(state) {
  const viewer = state.viewer;
  el.account.textContent = viewer?.username ? `@${viewer.username}` : viewer?.fbid ? 'account connected' : '';
  const at = state.health?.lastSuccessAt;
  // A walk through the inbox takes minutes and writes its progress into health
  // after every page, so it reports itself here rather than leaving the header
  // frozen on whatever it said when the button was pressed.
  const walk = state.health?.backfill;
  const scroll = state.health?.scroll;
  const history = state.health?.history;
  if (history?.running) {
    el.sync.textContent = `reading conversations · ${history.threads ?? 0}/${history.total ?? 0}`;
    return;
  }
  if (scroll?.running) { el.sync.textContent = `scrolling the inbox · +${scroll.gained ?? 0}`; return; }
  if (walk?.running) { el.sync.textContent = `loading all · ${walk.pages ?? 0} pages`; return; }
  if (!refreshing) el.sync.textContent = at ? `updated ${sinceLabel(at)}` : '';
}

function setLinkedState(result) {
  const linked = Boolean(result?.ok ?? result?.linked ?? false);
  el.linked.dataset.linked = String(linked);
  el.linked.textContent = linked ? 'tab linked' : 'link a tab';
}

/**
 * The bridge chip. Absent while the daemon isn't running — the bridge is
 * optional and an "off" chip would be permanent furniture for something the
 * user never asked for. Present it only when there is something true to say.
 */
function setBridgeState({ live, syncedAt, stuck, unsent }) {
  el.bridge.hidden = !live;
  if (!live) return;
  // Not landing is worse than queued: polling still answers, so the bridge goes
  // on looking connected while whoever reads it gets an inbox that stopped
  // moving. Said first, for that reason.
  el.bridge.dataset.state = unsent ? 'stuck' : stuck ? 'stuck' : 'live';
  el.bridge.textContent = unsent ? 'bridge · not sending' : stuck ? `bridge · ${stuck} queued` : 'bridge';
  el.bridge.title = unsent
    ? `The snapshot is not reaching the bridge (${unsent} tries). Whatever reads it is seeing an older inbox.`
    : stuck
      ? 'Waiting: the conversation is not captured yet, or there is already text in the reply box. Retried every few seconds.'
      : syncedAt ? `Snapshot sent ${sinceLabel(syncedAt)}` : 'Bridge is up';
}

/**
 * The error band. `delay` is for failures nobody asked to see: a first load
 * against a sleeping worker fails and the retry succeeds, and a band that
 * appears for a second on every open is noise that also shoves the page down.
 * Anything the user just pressed reports immediately.
 */
function showBand(code, { delay = 0 } = {}) {
  clearTimeout(bandTimer);
  const paint = () => {
    el.bandText.textContent = humanError(code);
    el.band.hidden = false;
  };
  if (delay) bandTimer = setTimeout(paint, delay);
  else paint();
}

const hideBand = () => { clearTimeout(bandTimer); el.band.hidden = true; };

// ── State ─────────────────────────────────────────────────────────────────

async function load() {
  let state;
  try {
    state = await send({ type: 'crm-state' });
  } catch {
    // The worker is gone or broken: say so instead of showing the skeleton
    // forever — but only if it is still true in a few seconds. Waking one up is
    // the ordinary case and it fails exactly like this.
    el.skeleton.hidden = true;
    showBand('worker', { delay: BAND_DELAY_MS });
    return;
  }
  threads = state?.threads ?? [];
  await loadOutreach();
  renderHeader(state ?? {});
  if (state?.health?.lastError) showBand(state.health.lastError, { delay: BAND_DELAY_MS }); else hideBand();
  renderModes();
  renderStats();
  paintQueue();
  renderSelected();
  await renderThread();
}

/**
 * The other half's data, straight from storage rather than through the worker:
 * the tables run to thousands of rows, and nothing here writes to them.
 */
async function loadOutreach() {
  const meta = await chrome.storage.local.get(['campaigns', 'activeCampaign', 'inbox', 'inboxScannedAt']);
  campaigns = (Array.isArray(meta.campaigns) ? meta.campaigns : []).filter((c) => c?.id);
  campaign = activeCampaign(campaigns, meta.activeCampaign);
  inbox = meta.inbox ?? {};
  // Whether anyone has ever looked, as opposed to what was found: a run reads the
  // inbox before its first lead, and before that "0 replies" is not a result.
  inboxScanned = Boolean(meta.inboxScannedAt);
  tables = campaigns.length ? await chrome.storage.local.get(campaigns.map((c) => leadsKey(c.id))) : {};
  reindex();
}

function reindex() {
  allLeads = indexTables(campaigns.map((c) => ({ campaign: c, leads: tables[leadsKey(c.id)] })));
  leadList = campaign ? tables[leadsKey(campaign.id)] ?? [] : [];
  leads = indexLeads(leadList);
}

// ── What is on screen ─────────────────────────────────────────────────────

function setMode(next) {
  if (next === mode) return;
  mode = next;
  saveView();
  renderModes();
  renderStats();
  paintQueue();
}

async function loadPictures() {
  pictures = (await chrome.storage.local.get(AVATARS_KEY))[AVATARS_KEY] ?? {};
}

async function loadFolders() {
  folders = (await chrome.storage.local.get(FOLDERS_KEY))[FOLDERS_KEY] ?? [];
}

/** The queue makes and deletes them; the page keeps them and hands them back out. */
async function saveFolders(next) {
  folders = next;
  paintQueue();
  renderCard();
  await chrome.storage.local.set({ [FOLDERS_KEY]: next });
}

async function loadView() {
  const saved = (await chrome.storage.local.get(VIEW_KEY))[VIEW_KEY];
  if (saved?.mode === 'campaign' || saved?.mode === 'all') mode = saved.mode;
  statsOpen = Boolean(saved?.statsOpen);
}

const saveView = () => chrome.storage.local.set({ [VIEW_KEY]: { mode, statsOpen } });

// ── The operator's own columns ────────────────────────────────────────────

/**
 * Stage / note / tags / folder go through the worker, so this page and the
 * bridge land in the store's single write queue. The rows are updated locally
 * first — the authoritative repaint arrives via storage.onChanged.
 *
 * One message for the whole set, not one per row: the store writes the index
 * once, so a selection of fifty repaints the page once instead of fifty times.
 */
async function patchMany(threadIDs, fields) {
  const wanted = new Set(threadIDs);
  for (const thread of threads) {
    if (wanted.has(thread.threadID)) Object.assign(thread, fields);
  }
  paintQueue();
  renderStats(); // a stage moved, so the funnel above moved with it
  renderSelected();
  try {
    await send({ type: 'crm-patch-many', threadIDs, fields });
  } catch {
    showBand('worker');
  }
}

const patch = (threadID, fields) => patchMany([threadID], fields);

/** The dot clears on the click, not after a round trip. */
function markRead(threadIDs) {
  const wanted = new Set(threadIDs);
  let cleared = false;
  for (const thread of threads) {
    if (!wanted.has(thread.threadID) || !thread.needsAttention) continue;
    thread.needsAttention = false;
    cleared = true;
  }
  if (cleared) send({ type: 'crm-mark-read', threadIDs }).catch(() => {});
  return cleared;
}

async function saveNote() {
  clearTimeout(noteTimer);
  const threadID = noteThreadID;
  if (!threadID) return;
  const thread = threads.find((t) => t.threadID === threadID);
  if (!thread || (thread.note ?? '') === el.note.value) return;
  await patch(threadID, { note: el.note.value });
}

/**
 * The composer is one box for the whole inbox, and what is in it belongs to the
 * conversation on screen. So the textarea holds the selected thread's draft and
 * `drafts` holds everyone else's, and the two change hands together — otherwise
 * a reply started for one person is in the box, and addressed to the next.
 */
const stashComposer = () => { if (selectedID) drafts.keep(selectedID, el.composeText.value); };
const showComposer = () => { el.composeText.value = drafts.textFor(selectedID); };

async function select(threadID) {
  const switching = threadID !== selectedID;
  if (switching) {
    await saveNote(); // the note belongs to the thread being left
    stashComposer(); // and so does the reply somebody started writing to them
  }
  el.tagInput.value = ''; // a half-typed tag belongs to the lead being left, and blur has committed it
  selectedID = threadID;
  if (switching) showComposer(); // and this one gets back whatever it was left with
  markRead([threadID]);
  paintQueue();
  renderSelected();
  await renderThread();
  // The linked tab follows the selection; it navigates on its own time and its
  // history capture arrives later through storage.
  send({ type: 'crm-select', threadID }).then(setLinkedState, () => setLinkedState({ linked: false }));
}

async function sendReply(text) {
  const thread = threads.find((t) => t.threadID === selectedID);
  if (!thread) return;
  const ghost = { id: `p${++pendingSeq}`, threadID: thread.threadID, text };
  pending.push(ghost);
  await renderThread();

  let result;
  try {
    result = await send({ type: 'crm-send', threadID: thread.threadID, text });
  } catch {
    result = { ok: false, error: 'worker' };
  }
  if (result?.ok) {
    hideBand();
    await load();
    return;
  }
  // Nothing was sent, so hand the text back rather than making them retype it —
  // to the conversation it was written for, which is not necessarily the one on
  // screen: a send takes a moment and they may have moved on. Anything typed
  // there in the meantime wins.
  pending = pending.filter((p) => p !== ghost);
  stashComposer();
  if (!drafts.textFor(thread.threadID)) drafts.keep(thread.threadID, text);
  showComposer();
  showBand(result?.error ?? 'not-sent');
  await renderThread();
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  el.refresh.disabled = true;
  el.refresh.textContent = 'Refreshing…';
  el.sync.textContent = 'looking for conversations…';
  hideBand();
  try {
    let result;
    try {
      result = await send({ type: 'crm-refresh' });
    } catch {
      result = { ok: false, error: 'worker' };
    }
    await load();
    if (result?.ok) {
      const added = result.added ?? 0;
      el.sync.textContent = added ? `updated · +${added} new` : 'updated · no changes';
    } else {
      showBand(result?.error ?? 'unknown');
      el.sync.textContent = '';
    }
  } finally {
    refreshing = false;
    el.refresh.disabled = false;
    el.refresh.textContent = 'Refresh';
  }
}

/**
 * Read the whole inbox rather than its top page. Minutes, not seconds — the
 * walk is paced — so the progress the worker writes into health is what the
 * header shows while it runs, and the button says what it is doing.
 */
async function loadAll() {
  if (refreshing) return;
  refreshing = true;
  el.backfill.disabled = true;
  el.refresh.disabled = true;
  el.backfill.textContent = 'Loading…';
  hideBand();
  try {
    let result;
    try {
      result = await send({ type: 'crm-backfill' });
    } catch {
      result = { ok: false, error: 'worker' };
    }
    await load();
    if (!result?.ok) {
      showBand(result?.error ?? 'unknown');
      el.sync.textContent = '';
      return;
    }
    const read = result.history?.threads ?? 0;
    el.sync.textContent = `+${(result.added ?? 0) + (result.scroll?.gained ?? 0)} new · ${read} read`;
    // Anything but a finished list is a reason the user can act on, and the run
    // is resumable from exactly where it stopped. Two passes read the list and
    // only the LAST one that ran says how it ended — a walk that stopped at
    // `no-cursor` and handed over to the scroll is not something to report. The
    // list is reported before the history: a history pass that never ran is the
    // consequence, not the cause.
    const list = result.scroll?.stopped ?? result.stopped;
    // A scroll that went quiet having brought nothing is not proof the inbox
    // ended — it is also exactly what a scroll that moved the wrong thing looks
    // like. Only growth tells those apart, so staying silent here would be
    // reporting a complete inbox on no evidence.
    const done = list === 'exhausted' || (list === 'quiet' && (result.scroll?.gained ?? 0) > 0);
    const stopped = done ? result.history?.stopped : list;
    if (stopped && stopped !== 'exhausted') {
      showBand(stopped.startsWith('block:') ? stopped.slice('block:'.length) : stopped);
    }
  } finally {
    refreshing = false;
    el.backfill.disabled = false;
    el.refresh.disabled = false;
    el.backfill.textContent = 'Load all';
  }
}

// ── Events ────────────────────────────────────────────────────────────────

el.refresh.addEventListener('click', refresh);
el.backfill.addEventListener('click', loadAll);
el.bandAction.addEventListener('click', refresh);
el.emptyAction.addEventListener('click', () => send({ type: 'crm-open-instagram' }));
el.linked.addEventListener('click', () => send({ type: 'crm-linked-tab', open: true }).then(setLinkedState));

// The queue column runs itself; what it cannot know is who owns the rows, which
// campaign is on screen, and where a folder is kept.
const queue = createQueue({
  onSelect: select,
  onPatch: patchMany,
  onMarkRead: (threadIDs) => { if (markRead(threadIDs)) paintQueue(); },
  onShowAll: () => setMode('all'),
  onFolders: saveFolders,
});

const stageButton = (stage, className) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.dataset.stage = stage.id;
  button.textContent = stage.label;
  button.setAttribute('aria-pressed', 'false');
  button.addEventListener('click', () => { if (selectedID) patch(selectedID, { stage: stage.id }); });
  return button;
};

el.stages.replaceChildren(...PIPELINE.map((s) => stageButton(s, 'step')));
el.outcomes.replaceChildren(...OUTCOMES.map((s) => stageButton(s, 'outcome')));

el.folderOf.addEventListener('change', () => {
  if (selectedID) patch(selectedID, { folderID: el.folderOf.value || null });
});

// ── The next step ─────────────────────────────────────────────────────────

/** null clears it; an unparseable day is left alone rather than written as nothing. */
function setFollowUp(ms) {
  if (!selectedID) return;
  patch(selectedID, { followUpAt: ms });
}

el.followUp.addEventListener('change', () => {
  const ms = dayInputToMs(el.followUp.value);
  if (ms === null && el.followUp.value) return; // a half-typed date is not a decision
  setFollowUp(ms);
});
el.followUpClear.addEventListener('click', () => setFollowUp(null));
for (const button of el.followUpPresets.children) {
  button.addEventListener('click', () => setFollowUp(plusDays(Date.now(), Number(button.dataset.days))));
}

for (const button of el.modes.children) {
  button.addEventListener('click', () => setMode(button.dataset.mode));
}

el.statsToggle.addEventListener('click', () => {
  statsOpen = !statsOpen;
  saveView();
  renderStats();
});

el.note.addEventListener('input', () => {
  clearTimeout(noteTimer);
  noteTimer = setTimeout(saveNote, NOTE_SAVE_MS);
});
el.note.addEventListener('blur', saveNote);

// Enter commits, and so does leaving the field — clicking a row blurs before the
// click lands, so the tag still goes to the lead that was on screen.
function commitTags() {
  const raw = el.tagInput.value;
  el.tagInput.value = '';
  if (!raw.trim() || !selectedID) return;
  const thread = threads.find((t) => t.threadID === selectedID);
  if (!thread) return;
  const next = addTags(thread.tags, raw);
  if (next !== thread.tags) patch(thread.threadID, { tags: next });
}

el.tagInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  commitTags();
});
el.tagInput.addEventListener('blur', commitTags);

el.compose.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = el.composeText.value.trim();
  if (!text || el.composeSend.disabled) return;
  el.composeText.value = '';
  stashComposer(); // gone from the box, so there is nothing left to come back to
  el.composeSend.disabled = true;
  try {
    await sendReply(text);
  } finally {
    el.composeSend.disabled = false;
  }
});

el.composeText.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    el.compose.requestSubmit();
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  // A pass of kept faces landed. The event carries the new value, so there is
  // nothing to re-read — only the two places a face is drawn need repainting.
  if (AVATARS_KEY in changes) {
    pictures = changes[AVATARS_KEY].newValue ?? {};
    paintQueue();
    renderLeadHead();
  }

  // A second CRM tab made or deleted a folder. Ours holds the list, so it takes
  // the new one rather than the write it did not make.
  if (FOLDERS_KEY in changes) {
    folders = changes[FOLDERS_KEY].newValue ?? [];
    paintQueue();
    renderCard();
  }

  // A campaign made, renamed, deleted or switched changes which table this is —
  // and that is the one lead-table change that also changes who is on the list.
  if ('campaigns' in changes || 'activeCampaign' in changes) {
    load();
    return;
  }

  // A run rewrites its lead table lead by lead, several times a second, and
  // scans the inbox once at the start. What changes there is a lead's STATUS,
  // never who is on the list, so the card and the campaign numbers follow it
  // live and the list is left alone — repainting it would stutter for the whole
  // length of a run.
  const changedTables = Object.keys(changes).filter(isLeadsKey);
  if (changedTables.length || 'inbox' in changes || 'inboxScannedAt' in changes) {
    for (const key of changedTables) tables[key] = changes[key].newValue ?? [];
    if (changedTables.length) reindex();
    if ('inbox' in changes) inbox = changes.inbox.newValue ?? {};
    if ('inboxScannedAt' in changes) inboxScanned = Boolean(changes.inboxScannedAt.newValue);
    renderStats();
    renderSelected();
  }

  // Message keys look like `msg:<viewer>|<threadID>` — a history capture for the
  // thread on screen must repaint it, not just the list.
  const touchedOpenThread = Boolean(selectedID) && Object.keys(changes).some((k) => k.endsWith(`|${selectedID}`));
  if ('threads' in changes || 'health' in changes || touchedOpenThread) load();
});

// A drafted reply opens its thread and waits in the composer. It is never sent
// for you — the send button stays a decision a person makes.
//
// And it never overwrites a sentence somebody is in the middle of typing: the
// composer belongs to the person at the keyboard. The question is asked about
// the thread the draft is FOR — its half-written reply may be waiting in the
// book rather than on screen, and a draft the bridge itself put there earlier is
// its own to replace. Refusing leaves the draft queued, so it arrives the moment
// that conversation's box is free again.
startBridge({
  onDraft: async (threadID, text) => {
    stashComposer(); // the textarea is the truth about the thread on screen
    const busy = !drafts.isFree(threadID) // that conversation's own half-written reply
      || (threadID !== selectedID && !drafts.isFree(selectedID)); // and the screen it would take
    if (busy) throw new Error('composer busy');
    drafts.place(threadID, text);
    if (threadID !== selectedID) await select(threadID);
    showComposer();
    el.composeText.focus();
  },
  onStatus: setBridgeState,
});

send({ type: 'crm-linked-tab' }).then(setLinkedState, () => setLinkedState({ linked: false }));

// Which conversations you were looking at, and whether the panel was open, come
// back before the first paint — a view that resets itself on every open is one
// you set again on every open.
Promise.all([loadView(), loadPictures(), loadFolders()]).then(load);
