// Who gets what, when more than one CRM is connected.
//
// One daemon serves every browser and every Chrome profile: each profile has its
// own `chrome.storage`, its own Instagram account, and its own CRM tab polling
// the same socket. So both directions have to be addressed:
//
//   read  — a snapshot belongs to a source; an ambiguous read is refused, never guessed
//   write — a command names its target; an unaddressed one is handed to nobody
//
// Pure functions, no I/O: the daemon and the tests use the same rules.

const norm = (value) => String(value ?? '').trim().replace(/^@/, '').toLowerCase();

/** Does this command belong to the CRM instance that is asking? */
export function matchesSource(command, source) {
  const wantSource = norm(command?.source);
  if (wantSource) return wantSource === norm(source?.sourceId);

  const wantAccount = norm(command?.account);
  if (!wantAccount) return false; // unaddressed: nobody takes it

  const viewer = source?.viewer;
  if (!viewer) return false;
  return wantAccount === norm(viewer.username) || wantAccount === norm(viewer.fbid);
}

/**
 * Is this command addressed to the thing being forgotten? Compares the two
 * addresses directly — unlike matchesSource it does not go through a snapshot,
 * because the whole point of forgetting a mistyped account is that no snapshot
 * answers to it.
 */
export function addressedTo(command, target) {
  const source = norm(target?.source);
  if (source && norm(command?.source) === source) return true;
  const account = norm(target?.account);
  return Boolean(account) && norm(command?.account) === account;
}

/**
 * Queued commands no connected CRM will ever take — a mistyped account, or a
 * profile that stopped polling. They are never handed out, so the CRM's own
 * "queued" badge cannot show them; without this count they sit in the queue file
 * unmentioned. Reported by /health, cleared with /forget.
 */
export function countUnroutable(queue, snapshots) {
  const sources = Object.values(snapshots ?? {});
  return (queue ?? []).filter((command) => !sources.some((s) => matchesSource(command, s))).length;
}

export function describeSource(source) {
  return {
    sourceId: source?.sourceId ?? null,
    account: source?.viewer?.username ?? source?.viewer?.fbid ?? null,
    threadCount: source?.threadCount ?? 0,
    capturedAt: source?.capturedAt ?? null,
  };
}

/**
 * Which snapshot a reader means. Silence is the enemy here: analysing
 * praypolina's inbox while believing it is prayangelica's is a mistake nothing
 * downstream can catch, so an ambiguous query returns the choices instead.
 */
export function pickSnapshot(snapshots, query = {}) {
  const all = Object.values(snapshots ?? {});
  if (!all.length) return { snapshot: null, error: 'no snapshot yet' };

  const wanted = query.source || query.account;
  if (wanted) {
    const key = query.source ? { source: query.source } : { account: query.account };
    const hit = all.find((s) => matchesSource(key, s));
    if (hit) return { snapshot: hit };
    return { snapshot: null, error: query.source ? 'no such source' : 'no such account' };
  }

  if (all.length === 1) return { snapshot: all[0] };
  return {
    snapshot: null,
    error: 'ambiguous',
    choices: all.map(describeSource).sort((a, b) => String(a.account).localeCompare(String(b.account))),
  };
}
