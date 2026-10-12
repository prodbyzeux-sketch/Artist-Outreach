// One pure function: the whole `chrome.storage.local` dump in, the payload the
// bridge is allowed to see out. Pure so it is testable without Chrome, and so
// the rule below is enforced in one readable place.
//
// What must NEVER leave: `tpl` / `tplPage` / `tplThread`. Those are captured
// Instagram requests — cookies, tokens, app id. Everything else in storage is
// the operator's own CRM data and is safe on a loopback socket.

const MSG_PREFIX = 'msg:';

/**
 * Is this storage key part of the snapshot? The outreach half writes to the same
 * `chrome.storage.local`, and its run state changes constantly — without this
 * the bridge would push the whole inbox every second and a half for the length
 * of a send run.
 */
export const isSnapshotKey = (key) =>
  key === 'threads' || key === 'health' || key === 'viewer' || key === 'folders'
  || String(key).startsWith(MSG_PREFIX);

export function buildSnapshot(dump = {}) {
  const viewer = dump.viewer ?? null;
  const rows = Array.isArray(dump.threads) ? dump.threads : [];
  const mine = viewer?.fbid ? rows.filter((t) => t.viewerFbid === viewer.fbid) : rows;

  const threads = [...mine]
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
    .map((row) => ({
      ...row,
      messages: dump[`${MSG_PREFIX}${row.viewerFbid}|${row.threadID}`] ?? [],
    }));

  return {
    viewer,
    health: dump.health ?? {},
    // The rows carry a folder id and nothing else in the payload would say what
    // it is a name for.
    folders: Array.isArray(dump.folders) ? dump.folders : [],
    threadCount: threads.length,
    threads,
  };
}
