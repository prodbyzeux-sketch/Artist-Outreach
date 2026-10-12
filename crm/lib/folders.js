// Folders: where a conversation lives. Exactly one of them, or none.
//
// Deliberately not tags. A tag is a label and a lead carries as many as you like;
// a folder is a place and a lead is in one — which is what makes it something to
// browse by. Anything that wants "warm AND russian" is asking for tags, and tags
// are already there.
//
// The definitions live under their own storage key; the row carries only the id.
// Pure, so the strip can be counted in a test rather than in a browser.

/** Where the definitions live. The row itself carries only the id. */
export const FOLDERS_KEY = 'folders';

/** Rows in no folder at all. A reserved id — generated ones start with `f`. */
export const UNFILED = 'unfiled';

const MAX_NAME = 24;

const clean = (raw) => String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim();
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const list = (folders) => (Array.isArray(folders) ? folders : []);

/**
 * The same array back when nothing changed, so the caller skips the write — the
 * rule tags.js works by. The id comes from the caller: this file stays pure, and
 * a clock inside it would be untestable.
 */
export function addFolder(folders, name, id) {
  const current = list(folders);
  const label = clean(name);
  if (!label || !id || current.some((f) => same(f.name, label))) return current;
  return [...current, { id, name: label }];
}

export function removeFolder(folders, id) {
  const current = list(folders);
  const next = current.filter((f) => f.id !== id);
  return next.length === current.length ? current : next;
}

/** A name already taken, so asking for it twice can open it instead of failing quietly. */
export function findByName(folders, name) {
  const label = clean(name);
  return (label && list(folders).find((f) => same(f.name, label))) || null;
}

/**
 * A row's folder, forced to one that exists. Deleting a folder unfiles its rows
 * in a second write, and that write can fail or be interrupted — nothing may
 * show a lead as being somewhere it is not.
 */
export function folderOf(thread, folders) {
  const id = thread?.folderID;
  return id && list(folders).some((f) => f.id === id) ? id : '';
}

export const folderName = (folders, id) => list(folders).find((f) => f.id === id)?.name ?? '';

export function countByFolder(threads, folders) {
  const counts = Object.fromEntries(list(folders).map((f) => [f.id, 0]));
  counts[UNFILED] = 0;
  for (const thread of threads ?? []) {
    const id = folderOf(thread, folders);
    if (id) counts[id]++;
    else counts[UNFILED]++;
  }
  return counts;
}

/** A scope, like the campaign/all switch — not one of the filters under it. */
export function inFolder(threads, folder, folders) {
  if (!folder) return threads ?? [];
  if (folder === UNFILED) return (threads ?? []).filter((t) => !folderOf(t, folders));
  return (threads ?? []).filter((t) => folderOf(t, folders) === folder);
}
