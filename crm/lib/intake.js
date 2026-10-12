// The daemon's front door: who may knock, and what a command has to be.
//
// Both halves of that are a trust boundary. The socket is on 127.0.0.1, which
// keeps the network out — but not the browser: any page the operator has open
// can fetch localhost, and a POST with a plain content-type needs no preflight,
// so "the reply is unreadable cross-origin" stops nothing. Origin is the one
// header a page cannot forge, so it is what the door checks.
//
// And a command is data from outside. The store already limits WHICH keys a
// patch may write; this limits what may be in them. Not paranoia — `tags: 42`
// reaches storage and then throws on every later render of the list, which
// survives a reload: the CRM stays broken until storage is edited by hand.
//
// No I/O: the daemon and the tests use the same rules.

import { STAGES } from './stages.js';
import { normalizeTags } from './tags.js';

/** Long enough for a real note about a lead, short enough not to be a payload. */
export const NOTE_LIMIT = 4000;

const STAGE_IDS = new Set(STAGES.map((s) => s.id));

/** 1 Jan 2020 in ms. Anything below is a unit mistake, not a date. */
const FOLLOW_UP_FLOOR = 1577836800000;

/**
 * A request with no Origin is a tool on this machine — curl, a script, Claude
 * Code. Browsers always send one, so anything that does is a page, and only the
 * extension's own pages are ours.
 */
export function allowsOrigin(origin) {
  const value = String(origin ?? '');
  return value === '' || value.startsWith('chrome-extension://');
}

/** The operator's own columns. Anything else on a row is what Instagram said. */
const FIELD_RULES = {
  stage: (value) => (STAGE_IDS.has(value)
    ? { value }
    : { error: `stage must be one of ${[...STAGE_IDS].join(', ')}` }),
  tags: (value) => {
    const tags = normalizeTags(value);
    return tags ? { value: tags } : { error: 'tags must be a list of strings' };
  },
  note: (value) => {
    if (typeof value !== 'string') return { error: 'note must be a string' };
    if (value.length > NOTE_LIMIT) return { error: `note must be under ${NOTE_LIMIT} characters` };
    return { value };
  },
  followUpAt: (value) => {
    if (value === null) return { value: null }; // clearing it is a legitimate patch
    if (!Number.isFinite(value) || !Number.isInteger(value)) return { error: 'followUpAt must be a timestamp in ms, or null' };
    // Seconds instead of milliseconds is the mistake this catches: 1786… ms is
    // 1970, and a follow-up in 1970 is due forever without ever looking wrong.
    if (value < FOLLOW_UP_FLOOR) return { error: 'followUpAt looks like seconds, not milliseconds' };
    return { value };
  },
};

function normalizePatchFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return { error: 'fields must be an object' };
  }
  const out = {};
  for (const [key, rule] of Object.entries(FIELD_RULES)) {
    if (!(key in fields)) continue;
    const { value, error } = rule(fields[key]);
    if (error) return { error };
    out[key] = value;
  }
  // A patch of nothing applies cleanly, changes nothing and is acked — the
  // sender would never learn that `username` was not theirs to write.
  if (!Object.keys(out).length) return { error: `a patch must set one of: ${Object.keys(FIELD_RULES).join(', ')}` };
  return { fields: out };
}

/**
 * `patch` writes the operator's own columns onto a lead. `draft` puts text in
 * the composer for that thread — it does NOT send. Sending is a person pressing
 * a button, never a queued command. `backfill` reads the rest of the inbox: the
 * one command about the account rather than a conversation in it, so it is the
 * one that carries no threadID.
 *
 * Every command carries its target; `account` may be given once for the whole
 * batch. One without a target is refused rather than broadcast, because the
 * wrong CRM would take it and quietly find no such thread — or, for a backfill,
 * walk the wrong account's inbox.
 *
 * Returns the reason on refusal — a command rejected in silence is one the
 * sender waits on forever.
 */
const newId = () => 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);

export function normalizeCommand(input, batch = {}) {
  const threadID = typeof input?.threadID === 'string' ? input.threadID.trim() : '';
  if (!threadID && input?.type !== 'backfill') return { command: null, error: 'no threadID' };

  const account = String(input?.account ?? batch.account ?? '').trim();
  const source = String(input?.source ?? batch.source ?? '').trim();
  if (!account && !source) return { command: null, error: 'no account and no source' };

  const common = { id: newId(), threadID, account, source, createdAt: Date.now() };

  if (input.type === 'backfill') return { command: { ...common, type: 'backfill' }, error: null };

  if (input.type === 'patch') {
    const { fields, error } = normalizePatchFields(input.fields);
    if (error) return { command: null, error };
    return { command: { ...common, type: 'patch', fields }, error: null };
  }
  if (input.type === 'draft') {
    if (typeof input.text !== 'string' || !input.text.trim()) {
      return { command: null, error: 'draft needs text' };
    }
    return { command: { ...common, type: 'draft', text: input.text }, error: null };
  }
  return { command: null, error: `unknown type: ${String(input?.type)}` };
}
