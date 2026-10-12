// One click on the toolbar icon → the tabs the work actually needs, side by
// side in a named Chrome tab group: the Artist Outreach app (which holds
// Discover, Outreach and Inbox) and Instagram.
//
//   [ Artist Outreach ] Artist Outreach · Instagram
//
// The rules live in lib/workspace-plan.js; this file only carries them out and
// is the only place that touches chrome.tabs / chrome.tabGroups.

import { planWorkspace } from './lib/workspace-plan.js';
import { getConnection } from './platform/api.js';
import { DEFAULT_ORIGIN } from './platform/config.js';

const GROUP_TITLE = 'Artist Outreach';
const GROUP_COLOR = 'grey';
const IG_INBOX = 'https://www.instagram.com/direct/inbox/';

const wanted = async () => {
  // The app the extension is connected to — or the default one, which asks to sign in.
  const origin = (await getConnection())?.origin || DEFAULT_ORIGIN;
  return [
    { key: 'app', url: `${origin}/#outreach`, prefix: `${origin}/` },
    // Any Instagram tab will do — the inbox adopts whichever one is open as its
    // linked tab, so opening a second one here would just fight it.
    { key: 'instagram', url: IG_INBOX, prefix: 'https://www.instagram.com/' },
  ];
};

/** The window a new workspace goes to: the focused one, as long as it is a real one. */
async function currentWindowId() {
  const windows = await chrome.windows.getAll();
  const normal = windows.filter((w) => w.type === 'normal');
  const focused = normal.find((w) => w.focused);
  return (focused ?? normal[0])?.id ?? null;
}

export async function openWorkspace() {
  const list = await wanted();
  const [tabs, groups, windowId, stored] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabGroups.query({}),
    currentWindowId(),
    // Where a send run is driving right now, if one is (outreach/src/storage.js).
    chrome.storage.local.get('work'),
  ]);

  const plan = planWorkspace({
    wanted: list,
    tabs,
    groups,
    currentWindowId: windowId,
    groupTitle: GROUP_TITLE,
    busy: stored?.work ?? null,
  });

  const tabId = {};
  for (const { key, tabId: id, needsUnpin, needsMove } of plan.reuse) {
    if (needsUnpin) await chrome.tabs.update(id, { pinned: false });
    if (needsMove) await chrome.tabs.move(id, { windowId: plan.windowId, index: -1 });
    tabId[key] = id;
  }
  for (const { key, url } of plan.create) {
    // windowId may be null when every window is closed — then Chrome opens one.
    const created = await chrome.tabs.create({ url, active: false, ...(plan.windowId == null ? {} : { windowId: plan.windowId }) });
    tabId[key] = created.id;
  }

  // Grouped in the order they are wanted, so the strip always reads the same way.
  const tabIds = list.map((w) => tabId[w.key]).filter((id) => id !== undefined);
  // groupId and createProperties are mutually exclusive: one joins, one creates.
  const groupId = await chrome.tabs.group(
    plan.groupId !== null ? { tabIds, groupId: plan.groupId }
      : plan.windowId != null ? { tabIds, createProperties: { windowId: plan.windowId } }
        : { tabIds },
  );
  await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: GROUP_COLOR, collapsed: false });

  const focus = tabId[plan.activate];
  if (focus === undefined) return;
  await chrome.tabs.update(focus, { active: true });
  const tab = await chrome.tabs.get(focus);
  if (tab?.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
}
