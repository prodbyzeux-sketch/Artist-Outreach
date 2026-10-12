// The queue column: which conversations are on screen, and doing one thing to
// several of them at once.
//
// It owns everything left of the conversation — the folders, the folder you are
// standing in, the filters under it and the selection — so the page module keeps
// only what the three columns share. What it cannot own it asks for: the rows
// belong to the page (a bulk patch is applied there first, then sent), and the
// campaign/all switch belongs to the panel above.
//
//   folders  ─▶ scope ─▶ search / stage / due ─▶ rows
//                                                 └─ picked ─▶ the bulk bar

import { threadRow, option } from './view.js';
import { STAGES, stageLabel, filterThreads, countByStage } from '../lib/stages.js';
import { dueCount } from '../lib/followup.js';
import {
  UNFILED, addFolder, removeFolder, findByName, countByFolder, inFolder,
} from '../lib/folders.js';
import { nextPick, prunePicked } from '../lib/selection.js';

/**
 * Which nothing is on screen, and the way out of it. Four of them, and they need
 * different words: a filter that matches nobody, a folder nothing is in, a
 * campaign whose leads are not in this inbox, and an inbox nobody has captured.
 * The last one is its own panel; the other three are this.
 */
export function emptyMessage({ filtering, folder, campaignOnly }) {
  if (!filtering && folder) {
    return {
      title: 'This folder is empty',
      hint: 'Select conversations anywhere in the list and move them here.',
      label: 'Leave the folder',
      action: 'clear',
    };
  }
  if (!filtering && campaignOnly) {
    return {
      title: 'Nothing from this campaign yet',
      hint: 'None of its leads has a conversation here. Instagram hands back the recent threads — press Refresh, or look at everything.',
      label: 'Show all conversations',
      action: 'all',
    };
  }
  return { title: 'Nothing found', hint: 'No conversation matches the filter.', label: 'Clear filter', action: 'clear' };
}

/**
 * A folder with its count, and — for one somebody made — its own way out. The ×
 * is a button of its own rather than a click target inside the chip: a folder is
 * deleted once and browsed constantly.
 */
function folderChip({ id, label, count, active, onPick, onDelete }) {
  const chip = document.createElement('span');
  chip.className = 'folder';
  const pick = document.createElement('button');
  pick.className = 'folder-pick';
  pick.type = 'button';
  pick.setAttribute('aria-pressed', String(active));
  pick.textContent = label;
  const number = document.createElement('span');
  number.className = 'folder-count';
  number.textContent = String(count);
  pick.append(number);
  pick.addEventListener('click', () => onPick(id));
  chip.append(pick);

  if (onDelete) {
    const drop = document.createElement('button');
    drop.className = 'folder-drop';
    drop.type = 'button';
    drop.textContent = '×';
    drop.title = `Delete ${label}`;
    drop.setAttribute('aria-label', `Delete folder ${label}`);
    drop.addEventListener('click', () => onDelete(id, label, count));
    chip.append(drop);
  }
  return chip;
}

export function createQueue({ onSelect, onPatch, onMarkRead, onShowAll, onFolders }) {
  const el = {
    listCount: document.getElementById('list-count'),
    dueToggle: document.getElementById('due-toggle'),
    search: document.getElementById('search'),
    stageFilter: document.getElementById('stage-filter'),
    folders: document.getElementById('folders'),
    folderChips: document.getElementById('folder-chips'),
    folderAdd: document.getElementById('folder-add'),
    folderName: document.getElementById('folder-name'),
    bulk: document.getElementById('bulk'),
    bulkCount: document.getElementById('bulk-count'),
    bulkAll: document.getElementById('bulk-all'),
    bulkClear: document.getElementById('bulk-clear'),
    bulkFolder: document.getElementById('bulk-folder'),
    bulkStage: document.getElementById('bulk-stage'),
    bulkRead: document.getElementById('bulk-read'),
    skeleton: document.getElementById('skeleton'),
    empty: document.getElementById('empty'),
    noMatch: document.getElementById('no-match'),
    noMatchTitle: document.getElementById('no-match-title'),
    noMatchHint: document.getElementById('no-match-hint'),
    resetFilters: document.getElementById('reset-filters'),
    list: document.getElementById('list'),
  };

  /**
   * What the page last handed over; a repaint of our own reuses it. `all` is the
   * whole inbox and `scope` is the part the campaign switch left — deleting a
   * folder has to unfile every row in it, including ones off screen.
   */
  let view = { all: [], scope: [], selectedID: null, pictures: {}, campaignOnly: false, folders: [] };
  /** The folder being browsed: '' is everything, UNFILED is what is in none. */
  let folder = '';
  let query = '';
  let stage = '';
  let dueOnly = false;
  let picked = new Set();
  /** The row a shift-click counts its run from. */
  let anchor = null;
  /** The list as shown, in order — a run is what the eye sees between two rows. */
  let shownIDs = [];

  const ids = () => [...picked];

  // ── Painting ────────────────────────────────────────────────────────────

  function paint() {
    el.skeleton.hidden = true;
    // Deleted in another tab while it was the one being browsed: step back to
    // everything rather than standing in a folder with no chip to leave by.
    if (folder && folder !== UNFILED && !view.folders.some((f) => f.id === folder)) folder = '';
    const scoped = inFolder(view.scope, folder, view.folders);
    // Before the list is filtered, not after: dealing with the last due
    // conversation switches the filter off, and doing that a paint later would
    // show an empty list under a filter that is already gone.
    paintDue(scoped);
    const shown = filterThreads(scoped, { query, stage, due: dueOnly });
    const filtering = Boolean(query || stage || dueOnly);

    shownIDs = shown.map((t) => t.threadID);
    // A row that left the list takes its pick with it, or the next bulk action
    // lands on conversations nobody can see.
    const kept = prunePicked(picked, shownIDs);
    if (kept !== picked) picked = kept;

    paintFolders();
    paintFilter(scoped);
    paintBulk();

    el.empty.hidden = view.all.length > 0;
    el.noMatch.hidden = view.all.length === 0 || shown.length > 0;
    el.list.hidden = shown.length === 0;
    el.listCount.textContent = !scoped.length
      ? ''
      : shown.length === scoped.length ? String(scoped.length) : `${shown.length} of ${scoped.length}`;

    if (!el.noMatch.hidden) {
      const message = emptyMessage({ filtering, folder, campaignOnly: view.campaignOnly });
      el.noMatchTitle.textContent = message.title;
      el.noMatchHint.textContent = message.hint;
      el.resetFilters.textContent = message.label;
      el.resetFilters.dataset.action = message.action;
    }

    const fragment = document.createDocumentFragment();
    for (const thread of shown) {
      fragment.append(threadRow(thread, {
        selected: thread.threadID === view.selectedID,
        picked: picked.has(thread.threadID),
        pictures: view.pictures,
        onSelect: click,
        onPick: (id, event) => click(id, event, true),
      }));
    }
    el.list.replaceChildren(fragment);
  }

  /**
   * The due filter shows itself only when there is something due — a permanently
   * greyed "Due 0" is furniture. Switched on with nothing left to do, it switches
   * itself off rather than leaving the operator staring at an empty list they
   * cannot explain.
   */
  function paintDue(scoped) {
    const due = dueCount(scoped);
    if (!due && dueOnly) dueOnly = false;
    el.dueToggle.hidden = due === 0;
    el.dueToggle.textContent = `Due ${due}`;
    el.dueToggle.setAttribute('aria-pressed', String(dueOnly));
  }

  function paintFilter(scoped) {
    const counts = countByStage(scoped);
    for (const node of el.stageFilter.options) {
      node.textContent = node.value ? `${stageLabel(node.value)} · ${counts[node.value]}` : `All · ${scoped.length}`;
    }
  }

  /** Counted over the whole scope, so a chip says how many are in there — not how many survived the search. */
  function paintFolders() {
    const counts = countByFolder(view.scope, view.folders);
    const chips = [folderChip({
      id: '', label: 'All', count: view.scope.length, active: !folder, onPick: setFolder,
    })];
    // Only once something is filed and something is not: with everything unfiled
    // the chip is a second name for All, and with nothing unfiled it is a zero
    // nobody asked for. It stays while you are standing in it, empty or not.
    if ((counts[UNFILED] > 0 && counts[UNFILED] < view.scope.length) || folder === UNFILED) {
      chips.push(folderChip({
        id: UNFILED, label: 'Unfiled', count: counts[UNFILED], active: folder === UNFILED, onPick: setFolder,
      }));
    }
    for (const f of view.folders) {
      chips.push(folderChip({
        id: f.id, label: f.name, count: counts[f.id] ?? 0, active: folder === f.id, onPick: setFolder, onDelete: dropFolder,
      }));
    }
    el.folderChips.replaceChildren(...chips);
    el.folders.hidden = view.all.length === 0;
  }

  function paintBulk() {
    el.bulk.hidden = picked.size === 0;
    if (!picked.size) return;
    el.bulkCount.textContent = `${picked.size} selected`;
    el.bulkAll.hidden = picked.size === shownIDs.length;
    el.bulkFolder.replaceChildren(
      option('', 'Move to…'),
      ...view.folders.map((f) => option(f.id, f.name)),
      option(UNFILED, 'No folder'),
    );
    el.bulkStage.replaceChildren(option('', 'Set stage…'), ...STAGES.map((s) => option(s.id, s.label)));
  }

  // ── What is on screen ───────────────────────────────────────────────────

  function click(threadID, event, fromCheckbox = false) {
    const mode = event?.shiftKey ? 'range'
      : (fromCheckbox || event?.metaKey || event?.ctrlKey) ? 'toggle'
        : 'only';
    const before = picked;
    const result = nextPick({ picked, anchor, ids: shownIDs, id: threadID, mode });
    picked = result.picked;
    anchor = result.anchor;
    // A plain click is a click: it opens the conversation and drops the selection.
    if (mode === 'only') onSelect(threadID);
    const changed = picked.size !== before.size || [...picked].some((id) => !before.has(id));
    if (changed) paint();
  }

  function setFolder(id) {
    if (id === folder) return;
    folder = id;
    paint();
  }

  function clearFilters() {
    query = '';
    stage = '';
    dueOnly = false;
    folder = '';
    el.search.value = '';
    el.stageFilter.value = '';
    paint();
  }

  const clearPicks = () => {
    if (!picked.size) return;
    picked = new Set();
    paint();
  };

  // ── The folders themselves ──────────────────────────────────────────────

  /** Unique without a clock alone: two folders made in the same millisecond would share an id. */
  const newFolderID = () => `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  /**
   * Enter in the name field. A name already taken opens no second folder of the
   * same name — it is read as meaning that one, which is what makes this the
   * shortest way to file a selection: type where it goes, and it goes there.
   */
  async function commitFolder() {
    const name = el.folderName.value;
    el.folderName.value = '';
    el.folderName.hidden = true;
    if (!name.trim()) return;

    let target = findByName(view.folders, name);
    if (!target) {
      const id = newFolderID();
      const next = addFolder(view.folders, name, id);
      if (next === view.folders) return;
      target = { id, name };
      await onFolders(next);
    }
    if (picked.size) await onPatch(ids(), { folderID: target.id });
  }

  async function dropFolder(id, label, count) {
    const held = count === 1 ? '1 conversation stays' : `${count} conversations stay`;
    if (!window.confirm(`Delete the folder "${label}"? ${held} in the list, unfiled.`)) return;
    // Unfile first, and over the whole inbox rather than the campaign on screen:
    // a row must never be left pointing at a folder that is gone.
    const inside = inFolder(view.all, id, view.folders).map((t) => t.threadID);
    if (inside.length) await onPatch(inside, { folderID: null });
    if (folder === id) folder = '';
    await onFolders(removeFolder(view.folders, id));
  }

  // ── Events ──────────────────────────────────────────────────────────────

  el.stageFilter.replaceChildren(option('', 'All'), ...STAGES.map((s) => option(s.id, s.label)));

  el.search.addEventListener('input', () => { query = el.search.value; paint(); });
  el.stageFilter.addEventListener('change', () => { stage = el.stageFilter.value; paint(); });
  el.dueToggle.addEventListener('click', () => { dueOnly = !dueOnly; paint(); });

  el.resetFilters.addEventListener('click', () => {
    // The button is the way out of whichever nothing is on screen: a filter that
    // matches no one, an empty folder, or a campaign whose leads are not here.
    if (el.resetFilters.dataset.action === 'all') {
      onShowAll();
      return;
    }
    clearFilters();
    el.search.focus();
  });

  el.folderAdd.addEventListener('click', () => {
    el.folderName.hidden = !el.folderName.hidden;
    if (!el.folderName.hidden) el.folderName.focus();
  });
  el.folderName.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); commitFolder(); }
    if (event.key === 'Escape') { el.folderName.value = ''; el.folderName.hidden = true; }
  });
  el.folderName.addEventListener('blur', () => { el.folderName.value = ''; el.folderName.hidden = true; });

  el.bulkAll.addEventListener('click', () => { picked = new Set(shownIDs); paint(); });
  el.bulkClear.addEventListener('click', clearPicks);
  el.bulkRead.addEventListener('click', () => onMarkRead(ids()));
  el.bulkFolder.addEventListener('change', () => {
    const value = el.bulkFolder.value;
    el.bulkFolder.value = '';
    if (!value) return;
    onPatch(ids(), { folderID: value === UNFILED ? null : value });
  });
  el.bulkStage.addEventListener('change', () => {
    const value = el.bulkStage.value;
    el.bulkStage.value = '';
    if (value) onPatch(ids(), { stage: value });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') clearPicks();
  });

  return {
    render(next) {
      view = { ...view, ...next };
      paint();
    },
  };
}
