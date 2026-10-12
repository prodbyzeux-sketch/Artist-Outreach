// leads.js — the queue: who is in it, what has happened to each of them, and the
// paste box that adds one by hand. Where the leads come FROM is ui/tables.js.
//
// The queue is derived from the loaded tables' handle columns (src/leads.js), so
// a lead that came from a file cannot simply be spliced out of the array: the
// next import or handle-column change brings it straight back. Removal is a
// tombstone (`removed: true`) instead, which the rebuild preserves for free
// because it reuses the existing object whenever the handle is still there.

import { STATUS, CLEARED, setLeads, newId } from "../storage.js";
import { rebuildLeads } from "../leads.js";
import { tableHandle } from "../spintax.js";
import { followupStatus, followupSummary } from "../followups.js";
import { $, debounce } from "./dom.js";

const PAGE = 200;                 // rows in the DOM at once; "Show more" adds another PAGE
const ORDER = [STATUS.pending, STATUS.sending, STATUS.sent, STATUS.skipped, STATUS.failed];

let leads = [];
let hooks = {};                   // { log } — set by initLeads
let locked = false;               // true while a run owns the lead list

// The follow-up column needs three things the queue never cared about before.
// Kept as one object so app.js can hand over a new one and re-render.
let fu = { steps: [], inbox: {}, settings: {} };

let filter = "all";               // "all" | a status | "removed"
let query = "";
let shown = PAGE;
const selected = new Set();

const saveLeads = () => setLeads(leads);

export const allLeads = () => leads;

// ── the lead record ───────────────────────────────────────────────────────────
// Leads written before `source` existed carry `manual: true` instead. Normalize
// on the way in rather than migrating storage: this is a local queue and the
// fallback costs one line.
const normalize = (l) => ({ ...l, source: l.source || (l.manual ? "manual" : "table") });

// The files changed: the queue is whatever they add up to now, plus the pasted
// leads and everything already known about a handle either way.
export function rebuildFromTables(tables) {
  leads = rebuildLeads(leads, tables);
  saveLeads();
  renderQueue();
}

// ── the queue ─────────────────────────────────────────────────────────────────
const statusOf = (l) => l.status || STATUS.pending;
const matchesQuery = (l) => !query || l.handle.includes(query);

function visibleLeads() {
  if (filter === "removed") return leads.filter((l) => l.removed && matchesQuery(l));
  const live = leads.filter((l) => !l.removed && matchesQuery(l));
  return filter === "all" ? live : live.filter((l) => statusOf(l) === filter);
}

function renderChips() {
  const box = $("statusChips");
  box.innerHTML = "";
  const live = leads.filter((l) => !l.removed);
  const counts = [["all", live.length], ...ORDER.map((s) => [s, live.filter((l) => statusOf(l) === s).length])];
  counts.push(["removed", leads.filter((l) => l.removed).length]);

  for (const [key, n] of counts) {
    if (!n && key !== "all" && key !== filter) continue;   // don't list what isn't there
    const chip = document.createElement("button");
    chip.className = "chip chip--filter" + (filter === key ? " is-on" : "");
    chip.textContent = `${key} ${n}`;
    chip.addEventListener("click", () => {
      filter = key;
      shown = PAGE;
      renderQueue();
    });
    box.append(chip);
  }
}

const timeOf = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—");

// "in 5h", "in 3d" — how long until this lead is owed its next step.
function until(ms) {
  const min = Math.round((ms - Date.now()) / 60000);
  if (min <= 0) return "now";
  if (min < 60) return `in ${min}m`;
  const h = Math.round(min / 60);
  return h < 48 ? `in ${h}h` : `in ${Math.round(h / 24)}d`;
}

// One lead's follow-up standing, small enough to live in a 62px column. The
// number is always what has GONE OUT; the word after it is what happens next.
const FU_LABEL = {
  due: (s) => ({ text: `${s.sent}▸`, cls: "fu--due", title: `Follow-up ${s.sent + 1} is due now` }),
  waiting: (s) => ({ text: `${s.sent} ${until(s.dueAt)}`, cls: "fu--wait",
    title: `Follow-up ${s.sent + 1} goes out ${until(s.dueAt)}` }),
  replied: (s) => ({ text: s.sent ? `${s.sent} ✓` : "✓", cls: "fu--replied", title: "They answered — nothing more goes out" }),
  done: (s) => ({ text: `${s.sent} ✓`, cls: "fu--done", title: "Every step has gone out" }),
  stopped: (s) => ({ text: `${s.sent} ⊘`, cls: "fu--stopped", title: s.error || "Follow-ups stopped for this lead" }),
  off: (s) => ({ text: s.sent ? String(s.sent) : "", cls: "", title: "" }),
};

function followupCell(lead) {
  const s = followupStatus(lead, fu.inbox, fu.steps, fu.settings);
  const { text, cls, title } = FU_LABEL[s.state](s);
  const el = document.createElement("span");
  el.className = `cell cell--fu ${cls}`.trim();
  el.textContent = text;
  if (title) el.title = title;
  return el;
}

// The counts above the queue — the answer to "is anything actually going to
// happen when I press Start", which no per-row cell can give at 600 rows.
function renderFollowupMonitor() {
  const box = $("followupMonitor");
  const on = fu.settings.followupsEnabled && fu.steps.length;
  box.hidden = !on;
  if (!on) return;
  const s = followupSummary(leads.filter((l) => !l.removed), fu.inbox, fu.steps, fu.settings);
  box.innerHTML = "";
  const parts = [
    ["due now", s.due, "fu--due"],
    ["waiting", s.waiting, ""],
    ["replied", s.replied, "fu--replied"],
    ["all sent", s.done, ""],
    ["stopped", s.stopped, "fu--stopped"],
  ];
  const head = document.createElement("span");
  head.className = "fu-monitor-head";
  head.textContent = `Follow-ups · ${s.sent} sent`;
  box.append(head);
  for (const [label, n, cls] of parts) {
    if (!n) continue;
    const chip = document.createElement("span");
    chip.className = `fu-count ${cls}`.trim();
    chip.textContent = `${n} ${label}`;
    box.append(chip);
  }
  if (!s.due && !s.waiting) {
    const none = document.createElement("span");
    none.className = "muted";
    none.textContent = s.replied || s.done ? "nothing owed right now" : "nobody is eligible yet — leads become eligible once written to";
    box.append(none);
  }
}

function leadRow(l) {
  const row = document.createElement("div");
  row.className = "lead" + (l.removed ? " lead--removed" : "");
  row.dataset.id = l.id;

  const check = document.createElement("label");
  check.className = "cell cell--check";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = selected.has(l.id);
  box.disabled = locked;
  box.addEventListener("change", () => {
    if (box.checked) selected.add(l.id); else selected.delete(l.id);
    renderBulkBar();
  });
  check.append(box);

  const name = document.createElement("span");
  name.className = "cell cell--handle";
  name.textContent = "@" + l.handle;
  name.title = l.source === "manual" ? "pasted by hand" : "from the table";

  const badge = document.createElement("span");
  badge.className = `cell cell--status badge badge--${statusOf(l)}`;
  badge.textContent = statusOf(l);

  const when = document.createElement("span");
  when.className = "cell cell--when muted";
  when.textContent = timeOf(l.ts);

  const note = document.createElement("span");
  note.className = "cell cell--note muted";
  note.textContent = l.error || "";
  note.title = l.error || "";

  const act = document.createElement("span");
  act.className = "cell cell--act";
  if (!locked) {
    if (l.removed) {
      act.append(rowButton("Restore", () => patch([l.id], { removed: undefined })));
    } else {
      if (statusOf(l) !== STATUS.pending) {
        act.append(rowButton("↺", () => patch([l.id], CLEARED), "Return to queue"));
      }
      act.append(rowButton("⊘", () => patch([l.id], { status: STATUS.skipped, error: "skipped by hand", ts: Date.now() }), "Skip"));
      act.append(rowButton("✕", () => patch([l.id], { removed: true }), "Remove"));
    }
  }

  row.append(check, name, badge, followupCell(l), when, note, act);
  return row;
}

function rowButton(label, onClick, title) {
  const b = document.createElement("button");
  b.className = "btn btn--icon btn--ghost";
  b.textContent = label;
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

function patch(ids, fields) {
  const set_ = new Set(ids);
  leads = leads.map((l) => (set_.has(l.id) ? { ...l, ...fields } : l));
  saveLeads();
  ids.forEach((id) => selected.delete(id));
  renderQueue();
}

// What a bulk action did, in the place the count sits — a copy that went to the
// clipboard shows nothing on screen otherwise, and one that failed shows nothing
// at all.
let bulkNote;
function flashBulk(text) {
  $("bulkCount").textContent = text;
  clearTimeout(bulkNote);
  bulkNote = setTimeout(renderBulkBar, 2500);
}

// The selected handles, in queue order, one per line — the shape the paste box
// above takes, so a selection can be moved to another list or kept before it is
// removed.
async function copySelected() {
  const handles = leads.filter((l) => selected.has(l.id)).map((l) => l.handle);
  if (!handles.length) return;
  try {
    await navigator.clipboard.writeText(handles.join("\n"));
    flashBulk(`${handles.length} handle${handles.length === 1 ? "" : "s"} copied`);
  } catch (e) {
    flashBulk(`couldn't copy (${e.message})`);
  }
}

function renderBulkBar() {
  const bar = $("bulkBar");
  bar.hidden = locked || selected.size === 0;
  if (bar.hidden) return;
  clearTimeout(bulkNote);
  $("bulkCount").textContent = `${selected.size} selected`;
  const removedView = filter === "removed";
  $("bulkRestore").hidden = !removedView;
  $("bulkRequeue").hidden = removedView;
  $("bulkSkip").hidden = removedView;
  $("bulkRemove").hidden = removedView;
}

// The lock has to reach the controls that FILL the queue, not just the rows:
// each of them rewrites the whole `leads` key from the page while the worker is
// writing that same key per send. Disabled rather than guarded, so a control
// that can't be used looks that way and the #queueLocked banner says why —
// instead of a live-looking button whose click silently does nothing. The file
// controls are the other half of this, and ui/tables.js locks its own.
function renderSourceLock() {
  // The textarea goes down with its button: a live box whose only exit is dead
  // is the same silent no-op that Add usernames already had to answer for.
  $("usernameInput").disabled = locked;
  $("addUsernames").disabled = locked;
  $("resetStatuses").disabled = locked;
}

export function renderQueue() {
  renderChips();
  renderFollowupMonitor();

  const list = $("leadList");
  const visible = visibleLeads();
  list.innerHTML = "";
  visible.slice(0, shown).forEach((l) => list.append(leadRow(l)));

  $("showMore").hidden = visible.length <= shown;
  $("showMore").textContent = `Show ${Math.min(PAGE, visible.length - shown)} more`;
  $("queueLocked").hidden = !locked;
  renderSourceLock();
  $("selectAll").disabled = locked;
  $("selectAll").checked = visible.length > 0 && visible.every((l) => selected.has(l.id));

  const live = leads.filter((l) => !l.removed);
  const pending = live.filter((l) => statusOf(l) === STATUS.pending).length;
  $("queueSummary").textContent = leads.length
    ? `${Math.min(shown, visible.length)} of ${visible.length} shown · ${live.length} leads · ${pending} pending`
    : "No leads yet — upload a table or paste usernames above.";

  renderBulkBar();
}

// One row changed under a running send: patch it in place instead of rebuilding
// a list that can be thousands of rows long.
export function refreshLead(lead) {
  const i = leads.findIndex((l) => l.id === lead.id);
  if (i < 0) return renderQueue();
  leads[i] = normalize(lead);
  const row = $("leadList").querySelector(`[data-id="${lead.id}"]`);
  renderChips();
  renderFollowupMonitor();
  if (row) row.replaceWith(leadRow(leads[i]));   // not on screen? the counts above still moved
}

// The follow-up column reads three things that live outside this section — the
// steps, the reply facts, the settings — so they are pushed in rather than
// fetched here, and any of them changing re-draws the queue.
export function setFollowupContext(next) {
  fu = { ...fu, ...next };
  renderQueue();
}

export function setLocked(v) {
  locked = v;
  if (locked) selected.clear();
  renderQueue();
}

export function replaceLeads(next) {
  leads = next.map(normalize);
  renderQueue();
}

// Adding by hand can legitimately change nothing on screen — a handle already in
// the queue, or text with no handle in it — so the outcome is always spelled out
// next to the button rather than left to a row silently not appearing.
function reportAdded({ added, restored, already, hadText }) {
  const parts = [];
  if (added) parts.push(`added ${added}`);
  if (restored) parts.push(`restored ${restored} removed`);
  if (already) parts.push(`${already} already in the queue`);
  if (!parts.length && hadText) parts.push("no Instagram handle in that text");

  const out = $("addResult");
  out.textContent = parts.join(" · ");
  out.hidden = !parts.length;
  if (added || restored) hooks.log(parts.join(" · "));
}

// ── wiring ────────────────────────────────────────────────────────────────────
export function initLeads(loadedLeads, handlers) {
  leads = loadedLeads.map(normalize);
  hooks = handlers;

  $("addUsernames").addEventListener("click", () => {
    const input = $("usernameInput");
    const hadText = !!input.value.trim();
    const typed = [...new Set(input.value.split(/[\n,]/).map(tableHandle).filter(Boolean))];
    const known = new Map(leads.map((l) => [l.handle, l]));

    const fresh = typed
      .filter((h) => !known.has(h))
      .map((h) => ({ id: newId("l"), handle: h, source: "manual", status: STATUS.pending }));
    // Typing a handle by hand is an explicit request for that lead, so it
    // outranks a tombstone — which only exists to survive table re-imports.
    const restore = new Set(typed.filter((h) => known.get(h)?.removed));

    // Newest first: a lead you just typed — new or dug back out — has to be a
    // row you can see, not row 601 of a list that renders 200 at a time.
    const revived = leads.filter((l) => restore.has(l.handle)).map((l) => ({ ...l, removed: undefined }));
    leads = [...fresh, ...revived, ...leads.filter((l) => !restore.has(l.handle))];
    input.value = "";

    if (fresh.length || restore.size) {
      saveLeads();
      // A filter or a search term would hide what was just added, which is the
      // complaint this whole branch exists to answer.
      filter = "all";
      query = "";
      $("leadSearch").value = "";
      shown = PAGE;
    }
    renderQueue();
    reportAdded({
      added: fresh.length,
      restored: restore.size,
      already: typed.length - fresh.length - restore.size,
      hadText,
    });
  });

  // Last add's result must not sit there while a new name is being typed.
  $("usernameInput").addEventListener("input", () => { $("addResult").hidden = true; });

  $("leadSearch").addEventListener("input", debounce((e) => {
    query = e.target.value.trim().toLowerCase().replace(/^@+/, "");
    shown = PAGE;
    renderQueue();
  }, 200));

  $("showMore").addEventListener("click", () => { shown += PAGE; renderQueue(); });

  $("selectAll").addEventListener("change", (e) => {
    const visible = visibleLeads().slice(0, shown);
    if (e.target.checked) visible.forEach((l) => selected.add(l.id));
    else visible.forEach((l) => selected.delete(l.id));
    renderQueue();
  });

  const bulk = (fields) => patch([...selected], fields);
  $("bulkCopy").addEventListener("click", copySelected);
  $("bulkRequeue").addEventListener("click", () => bulk(CLEARED));
  $("bulkSkip").addEventListener("click", () => bulk({ status: STATUS.skipped, error: "skipped by hand", ts: Date.now() }));
  // The one bulk action that takes something away, and it takes more than the
  // rows: a removed lead leaves the dashboard too. Everything it costs is in the
  // question, including the way back.
  $("bulkRemove").addEventListener("click", () => {
    const n = selected.size;
    const sent = leads.filter((l) => selected.has(l.id) && l.status === STATUS.sent).length;
    const asked = `Remove ${n} lead${n === 1 ? "" : "s"} from the queue?`
      + (sent ? `\n\n${sent} of them ${sent === 1 ? "has" : "have"} been written to — their sends and replies `
        + "leave the dashboard with them." : "")
      + "\n\nNothing is lost: the Removed filter above lists them, and Restore puts them back.";
    if (!confirm(asked)) return;
    bulk({ removed: true });
  });
  $("bulkRestore").addEventListener("click", () => bulk({ removed: undefined }));
  $("bulkClear").addEventListener("click", () => { selected.clear(); renderQueue(); });

  // Reset statuses is about statuses only — it must not resurrect what was removed.
  $("resetStatuses").addEventListener("click", () => {
    leads = leads.map((l) => ({ ...l, ...CLEARED }));
    saveLeads();
    renderQueue();
  });

  renderQueue();
}
