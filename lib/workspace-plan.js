// What one click on the icon should do to the tabs that are already open.
//
// Kept pure and away from chrome.* so the rules can be read and tested: which
// tab counts as already-open, which window the workspace lands in, and whether
// there is a group to join. The shell (workspace.js) only carries the plan out.
//
// Two Chrome facts the rules exist for: a group lives in ONE window, so tabs
// scattered across windows have to be gathered first; and a pinned tab cannot be
// grouped at all, so the linked Instagram tab loses its pin — the group does the
// same job of keeping it in place, and visibly.

const matchesWant = (tab, want) => typeof tab.url === 'string' && tab.url.startsWith(want.prefix ?? want.url);

export function planWorkspace({
  wanted,
  tabs = [],
  groups = [],
  currentWindowId,
  groupTitle,
  activate,
  busy = null,
} = {}) {
  // The send run owns a window through chrome.debugger. Its Instagram tab looks
  // exactly like the one we want, and taking it would break the run mid-lead.
  const free = tabs.filter((tab) => tab.id !== busy?.tabId && tab.windowId !== busy?.windowId);
  const found = [];
  const create = [];
  const taken = new Set();

  for (const want of wanted) {
    // First match wins: a second CRM tab is somebody's copy, not a second CRM.
    const hit = free.find((tab) => !taken.has(tab.id) && matchesWant(tab, want));
    if (!hit) { create.push({ key: want.key, url: want.url }); continue; }
    taken.add(hit.id);
    found.push({ key: want.key, tab: hit });
  }

  // The workspace goes where its tabs already are; the current window is the
  // fallback, not the rule — clicking the icon should not drag an open CRM
  // across windows.
  const windowId = found[0]?.tab.windowId ?? currentWindowId;
  const ourGroup = groups.find((group) => group.title === groupTitle && group.windowId === windowId);

  return {
    windowId,
    groupId: ourGroup?.id ?? null,
    reuse: found.map(({ key, tab }) => ({
      key,
      tabId: tab.id,
      needsMove: tab.windowId !== windowId,
      needsUnpin: tab.pinned === true,
    })),
    create,
    activate: activate ?? wanted[0]?.key ?? null,
  };
}
