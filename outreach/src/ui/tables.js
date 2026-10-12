// tables.js — the files a campaign writes to. Several can be loaded at once and
// they need nothing in common: each keeps its own headers and its own handle
// column, and together they are one audience (src/spintax.js).
//
// Nothing here owns the queue — a change to the files is handed to ui/leads.js,
// which rebuilds it from ALL of them (src/leads.js). That is what makes a second
// import add to the list instead of replacing it.

import { setTables } from "../storage.js";
import { parseTableFile } from "../table.js";
import { matchColumn, tableHandles, allHandles, allTokenKeys } from "../spintax.js";
import { $ } from "./dom.js";

let tables = [];
let hooks = {};                  // { onChanged, insertToken } — set by initTables
let locked = false;              // true while a run owns the queue these tables feed

// Which previews are open, by file name rather than position — the list
// re-renders on every change, and a preview open because you are deciding which
// column holds the handle must survive you picking one.
const openPreviews = new Set();

export const currentTables = () => tables;

// The files, the queue and the {variables} move together or the page lies about
// one of them.
function changed(note) {
  setTables(tables);
  render(note);
  hooks.onChanged();
}

// ── drawing ───────────────────────────────────────────────────────────────────
function render(note) {
  const list = $("tableList");
  list.innerHTML = "";
  tables.forEach((t, i) => list.append(tableCard(t, i)));
  list.hidden = !tables.length;

  const rows = tables.reduce((n, t) => n + t.rows.length, 0);
  $("tableMeta").textContent = tables.length
    ? `${tables.length} file${tables.length === 1 ? "" : "s"} · ${rows} rows · ${allHandles(tables).length} unique handles`
    : "";

  // No table, no chips: the Messages section's variable row is filled from here.
  $("varsRow").hidden = !tables.length;
  const chips = $("varChips");
  chips.innerHTML = "";
  for (const key of allTokenKeys(tables)) {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.textContent = `{${key}}`;
    chip.title = "Insert into the last-edited message";
    chip.addEventListener("click", () => hooks.insertToken(`{${key}}`));
    chips.append(chip);
  }

  // An import says what it did here; the rest of the time the cards speak for
  // themselves, and an empty list still has to say it is empty.
  $("tableStatus").textContent = note || (tables.length ? "" : "no files loaded");
}

function tableCard(table, index) {
  const card = document.createElement("div");
  card.className = "table-card";

  const head = document.createElement("div");
  head.className = "row row--between";
  const name = document.createElement("span");
  name.className = "table-name";
  name.textContent = table.fileName || "table";
  name.title = table.fileName || "";
  const tools = document.createElement("span");
  tools.className = "row";
  const meta = document.createElement("span");
  meta.className = "muted";
  meta.textContent = `${table.rows.length} rows · ${tableHandles(table).length} handles`;
  const remove = document.createElement("button");
  remove.className = "btn btn--tiny btn--danger";
  remove.textContent = "Remove";
  remove.disabled = locked;
  remove.addEventListener("click", () => removeTable(index));
  tools.append(meta, remove);
  head.append(name, tools);
  card.append(head);

  const match = matchColumn(table);
  if (match == null) {
    const err = document.createElement("div");
    err.className = "banner banner--error";
    err.textContent = "Couldn't find an Instagram-handle column — pick it below.";
    card.append(err);
  }

  const field = document.createElement("label");
  field.className = "field";
  const label = document.createElement("span");
  label.textContent = "Instagram-handle column";
  const select = document.createElement("select");
  select.disabled = locked;
  table.headers.forEach((h, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = h || `Column ${i + 1}`;
    if (i === match) opt.selected = true;
    select.append(opt);
  });
  select.addEventListener("change", (e) => {
    table.matchColumn = parseInt(e.target.value, 10);
    changed();
  });
  field.append(label, select);
  card.append(field, preview(table, match));

  return card;
}

function preview(table, match) {
  const wrap = document.createElement("details");
  wrap.className = "preview-wrap";
  wrap.open = openPreviews.has(table.fileName);
  wrap.addEventListener("toggle", () => {
    if (wrap.open) openPreviews.add(table.fileName);
    else openPreviews.delete(table.fileName);
  });
  const summary = document.createElement("summary");
  summary.textContent = "Preview the table";
  wrap.append(summary);

  const tbl = document.createElement("table");
  tbl.className = "preview";
  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  table.headers.forEach((h, i) => {
    const th = document.createElement("th");
    th.textContent = h || `Column ${i + 1}`;
    if (i === match) th.classList.add("is-match");
    htr.append(th);
  });
  thead.append(htr);
  const tbody = document.createElement("tbody");
  table.rows.slice(0, 6).forEach((row) => {
    const tr = document.createElement("tr");
    table.headers.forEach((_, i) => {
      const td = document.createElement("td");
      td.textContent = row[i] ?? "";
      tr.append(td);
    });
    tbody.append(tr);
  });
  tbl.append(thead, tbody);
  wrap.append(tbl);
  return wrap;
}

// ── loading and unloading ─────────────────────────────────────────────────────
async function loadFiles(files) {
  const error = $("tableError");
  error.hidden = true;
  // A big XLSX is unzipped and parsed in here, which is not instant — and the
  // card it becomes is the only other sign anything happened.
  $("tableStatus").textContent = files.length === 1 ? `reading ${files[0].name}…` : `reading ${files.length} files…`;
  const notes = [];
  const failed = [];

  for (const file of files) {
    try {
      const parsed = await parseTableFile(file);
      if (!parsed.headers.length) throw new Error("no columns found in it");
      const next = { ...parsed, matchColumn: null, fileName: file.name, importedAt: Date.now() };
      // Picking a file that is already loaded RELOADS it: the same export grown
      // a few rows is the usual reason to pick one twice, and a second card of
      // the same name could only ever be the stale one.
      const at = tables.findIndex((t) => t.fileName === next.fileName);
      if (at >= 0) tables[at] = next;
      else tables.push(next);
      // The preview earns its space right after an import, and only there.
      openPreviews.add(next.fileName);
      notes.push(`${next.fileName} ${at >= 0 ? "reloaded" : "added"} · ${next.rows.length} rows`);
    } catch (e) {
      failed.push(`${file.name} (${e.message})`);
    }
  }

  if (failed.length) {
    error.hidden = false;
    error.textContent = `Couldn't read ${failed.join(", ")}`;
  }
  if (notes.length) changed(notes.join(" · "));
  // Nothing landed: the banner says why, and there is nothing to save or
  // rebuild — but the status line must not be left reading a file it has
  // finished failing to read.
  else render();
}

// Tables that don't come from a file (the import from Artist Outreach,
// ui/platform.js): same rules as loadFiles — the same name RELOADS, another
// name ADDS — and the same lock while a run is using the queue.
export function addTables(list, note) {
  if (locked) return false;
  for (const next of list) {
    const at = tables.findIndex((t) => t.fileName === next.fileName);
    if (at >= 0) tables[at] = next;
    else tables.push(next);
    openPreviews.add(next.fileName);
  }
  changed(note);
  return true;
}

function removeTable(index) {
  const table = tables[index];
  const name = table.fileName || "this table";
  if (!confirm(`Remove ${name}?\n\nIts leads leave the queue unless another file lists them too — `
    + "everything they carry, sends and replies included, goes with them. Pasted usernames stay.")) return;
  tables = tables.filter((_, i) => i !== index);
  openPreviews.delete(table.fileName);
  changed();
}

// ── wiring ────────────────────────────────────────────────────────────────────
export function initTables(loaded, handlers) {
  tables = loaded;
  hooks = handlers;

  $("fileInput").addEventListener("change", (e) => {
    const files = [...e.target.files];
    e.target.value = "";   // allow re-selecting the same file
    // Unlike the buttons, `disabled` is not a hard gate here: if a label click
    // does open the picker, the change still lands in this handler.
    if (locked || !files.length) return;
    loadFiles(files);
  });

  render();
}

// A run owns the queue these files feed, so while it works they are read-only —
// every one of them rewrites the whole `leads` key from the page, and the worker
// is writing that same key per send. Disabled rather than guarded, so a control
// that can't be used looks that way and the queue's own banner says why.
export function setTablesLocked(v) {
  locked = v;
  $("fileInput").disabled = v;
  // A <label for> has no disabled attribute of its own, and a click on it can
  // still reach a disabled input's picker, so the label stops taking clicks.
  $("fileLabel").classList.toggle("is-disabled", v);
  const ao = document.getElementById("aoImport");
  if (ao) ao.disabled = v;
  render();
}
