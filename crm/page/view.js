// How things look: time formatting, error wording, and the DOM builders. Pure —
// every function takes data and returns nodes, so the page module keeps only
// state and events. Text always goes in through textContent: it was written by
// other people and must never be parsed as markup.

import { STAGES, DEFAULT_STAGE, stageOf, stageLabel } from '../lib/stages.js';
import { snippetMarker } from '../lib/parser.js';
import { duration } from '../lib/analytics.js';
import { isDue, followUpLabel, followUpShort, stageAgeDays, STALE_DAYS } from '../lib/followup.js';

const MINUTE = 60000, HOUR = 3600000, DAY = 86400000;

export function relativeTime(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < MINUTE) return 'now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  if (diff < 2 * DAY) return 'yesterday';
  return new Date(ms).toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
}

/**
 * When something last happened, as a phrase. `relativeTime` gives a token for a
 * column where the heading supplies the sense; a sentence needs the whole thing,
 * and `${relativeTime(at)} ago` put "updated now ago" and "updated yesterday
 * ago" on screen — three of its five answers are not durations.
 */
export function sinceLabel(ms, now = Date.now()) {
  if (!ms) return '';
  const diff = now - ms;
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 2 * DAY) return 'yesterday';
  return `on ${new Date(ms).toLocaleDateString('en-US', { day: 'numeric', month: 'short' })}`;
}

export const clockTime = (ms) =>
  (ms ? new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '');

const REASONS = {
  rateLimited: 'Instagram is holding requests back — we will try again later.',
  challenge: 'Instagram wants a confirmation. Open Instagram in the browser and confirm the login.',
  parse: "Instagram's response did not parse — the format changed. Conversations may be incomplete.",
  timeout: 'Could not get the conversations. Open Instagram in another tab and try again.',
  'tab-closed': 'The Instagram tab closed before the conversations arrived. Try again.',
  worker: 'The extension service is not responding. Reload this page or reinstall the extension.',
  'no-tab': 'Could not open the linked Instagram tab.',
  'not-on-thread': 'The linked tab never reached the conversation. Send again.',
  'no-composer': 'No message field in the linked tab — Instagram may not allow writing to this person.',
  'input-busy': 'Chrome will not let the extension type into the linked tab. Close DevTools on it and send again.',
  'not-sent': 'Instagram did not accept the message. Check the linked tab.',
  // Why a Load all run stopped before the end of the inbox. Every one of these
  // leaves the walk resumable: pressing Load all again continues from there.
  'no-template': 'Instagram has never been asked for a second page here. Open the linked tab, scroll the inbox once, then press Load all.',
  'bad-template': 'The stored inbox request cannot be paged. Reload Instagram in the linked tab and press Load all again.',
  'no-cursor': 'Instagram did not offer a next page.',
  'no-answer': 'The linked Instagram tab stopped answering mid-walk. Open it and press Load all again.',
  stalled: 'Instagram kept handing back the same page. Press Load all again later.',
  empty: "A page of the inbox came back with no conversations in it — Instagram's format may have changed.",
  cap: 'Stopped at the limit for one run. Press Load all again to keep going.',
  // Why the scrolling pass stopped. It drives Instagram's own list, so what can
  // go wrong is about the linked tab and the page in it.
  'no-inbox': 'The linked tab could not open Instagram Direct. Open it by hand and press Load all again.',
  'scroll:not-on-direct': 'The linked tab left Instagram Direct. Open Direct in it and press Load all again.',
  'scroll:no-list': "Nothing on the linked tab's page scrolls — Instagram Direct may not have finished loading. Press Load all again.",
  // Shown only when the scroll brought nothing: an inbox that has ended and a
  // scroll that moved the wrong thing look identical from here.
  quiet: 'Scrolling the inbox brought no new conversations. If some are missing, scroll the list in the linked tab by hand once, then press Load all again.',
  'no-thread-template': 'Could not read the conversations: open one in the linked tab once, then press Load all again.',
};

export const humanError = (code) => REASONS[code] ?? `Could not refresh: ${code}`;

/**
 * A message with no text arrives as a marker from the parser. The markers stay
 * language-neutral because they also travel over the bridge; the words the
 * interface shows are chosen here.
 */
const MEDIA_LABELS = {
  '[media]': 'attachment',
  '[voice]': 'voice message',
  '[story]': 'story',
  '[gif]': 'GIF',
  '[link]': 'link',
};

// Second lookup for messages captured before the parser knew about those lines:
// they sit in storage with the English sentence. A real message that happens to
// end in one is read as an attachment — the trade for not rewriting the store.
export const messageLabel = (text) => MEDIA_LABELS[text] ?? MEDIA_LABELS[snippetMarker(text)] ?? text;

/**
 * The last line of a conversation, and whose it was. Without the mark the list
 * cannot tell "they asked something" from "you answered it" — which is the whole
 * difference between a row that wants you and a row that is waiting on them.
 */
export const previewLine = (thread) => ({
  mine: Boolean(thread?.lastOutbound),
  text: messageLabel(thread?.lastMessage) || '—',
});

export function paragraph(text) {
  const p = document.createElement('p');
  p.textContent = text;
  return p;
}

export function option(value, label) {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  return node;
}

function initials(thread) {
  const div = document.createElement('div');
  div.className = 'avatar avatar-fallback';
  div.textContent = (thread.displayName || thread.username || '?').trim().slice(0, 1);
  return div;
}

/**
 * The kept picture if the worker has fetched one, otherwise Instagram's own link
 * while it is still signed, otherwise a letter. `pictures` is keyed by IG user
 * id because that is the thing that doesn't change — the url does, constantly.
 */
export function avatar(thread, pictures = {}) {
  const url = pictures[thread?.igUserID]?.data || thread?.avatarURL;
  if (typeof url !== 'string' || !(url.startsWith('https:') || url.startsWith('data:image/'))) {
    return initials(thread);
  }
  const img = document.createElement('img');
  img.className = 'avatar';
  img.src = url;
  img.alt = '';
  // A signature that died before the worker got to it: a letter, not a broken box.
  img.addEventListener('error', () => img.replaceWith(initials(thread)), { once: true });
  return img;
}

function marker(unread) {
  const span = document.createElement('span');
  span.className = unread ? 'dot' : 'dot-placeholder';
  if (unread) span.title = 'Not handled yet';
  return span;
}

/**
 * The tick that puts a row in a selection. A sibling of the row rather than
 * something inside it — a button inside a button is not a thing, and the row is
 * one. It sits over the picture, appears when the pointer or the keyboard
 * arrives, and stays once the row is picked.
 */
function pickBox(thread, picked, onPick) {
  const box = document.createElement('button');
  box.className = 'pick';
  box.type = 'button';
  box.setAttribute('aria-pressed', String(picked));
  box.setAttribute('aria-label', `Select ${thread.displayName || thread.username || 'this conversation'}`);
  box.addEventListener('click', (event) => onPick(thread.threadID, event));
  return box;
}

export function threadRow(thread, { selected, picked = false, onSelect, onPick, now = Date.now(), pictures = {} }) {
  const li = document.createElement('li');
  li.className = 'row-wrap';
  if (picked) li.dataset.picked = 'true';
  const row = document.createElement('button');
  row.className = 'row';
  row.type = 'button';
  row.setAttribute('aria-selected', String(selected));
  row.append(marker(thread.needsAttention), avatar(thread, pictures));

  const main = document.createElement('div');
  main.className = 'row-main';

  const top = document.createElement('div');
  top.className = 'row-top';
  const name = document.createElement('span');
  name.className = 'row-name';
  name.textContent = thread.displayName || thread.username || 'no name';
  const time = document.createElement('span');
  time.className = 'row-time';
  time.textContent = relativeTime(thread.lastActivityAt);
  top.append(name);
  // Only a stage somebody set: labelling every untouched thread "New" would
  // put a badge on the whole list and say nothing.
  // A promise to come back, once the day is here. A date still in the future is
  // on the card, not on the row: the list is for what needs doing.
  const due = isDue(thread, now);
  const stage = stageOf(thread);
  if (stage !== DEFAULT_STAGE) {
    const badge = document.createElement('span');
    badge.className = 'row-stage';
    badge.dataset.stage = stage;
    // How long it has held, but only once that is a fact worth reading, and only
    // where nothing louder is already asking for the same conversation. The list
    // is sorted by activity, so a lead nothing happens to sinks — this is the
    // one thing on the row that grows while everything else goes quiet.
    const age = due ? null : stageAgeDays(thread, now);
    badge.textContent = age !== null && age >= STALE_DAYS ? `${stageLabel(stage)} · ${age}d` : stageLabel(stage);
    if (age !== null && age >= STALE_DAYS) badge.title = `${age} days in ${stageLabel(stage)}`;
    top.append(badge);
  }
  // In the time's place, not next to it: three things after a name is one more
  // than a 300px column holds, and "you said you would come back" outranks "they
  // last wrote 3h ago" on the day it comes due. The time stays on the card.
  if (due) {
    const badge = document.createElement('span');
    badge.className = 'row-due';
    badge.textContent = followUpShort(thread.followUpAt, now);
    badge.title = `${followUpLabel(thread.followUpAt, now)} · last activity ${sinceLabel(thread.lastActivityAt, now)}`;
    top.append(badge);
  } else {
    top.append(time);
  }

  const preview = document.createElement('div');
  preview.className = 'row-preview';
  const line = previewLine(thread);
  if (line.mine) {
    const me = document.createElement('span');
    me.className = 'row-me';
    me.textContent = 'You: ';
    preview.append(me);
  }
  preview.append(line.text);

  main.append(top, preview);
  row.append(main);
  // The event goes with it: a click holding shift or the command key is a pick,
  // not an opening, and only the caller knows what is already selected.
  row.addEventListener('click', (event) => onSelect(thread.threadID, event));
  li.append(pickBox(thread, picked, onPick), row);
  return li;
}

/** The one-line summary under the lead's name in the card. */
export function leadSummary(thread) {
  const parts = [];
  if (thread.messageCount) parts.push(`${thread.messageCount} msg`);
  if (thread.lastActivityAt) parts.push(relativeTime(thread.lastActivityAt));
  if (thread.replied) parts.push('replied');
  return parts.join(' · ');
}

/**
 * What the outreach half already did to this lead, in one line. Absent when the
 * lead is not in the table at all — "not in outreach" on every card would be a
 * label on almost everything and mean nothing.
 */
const OUTREACH_LABELS = {
  pending: 'queued',
  sending: 'sending now',
  sent: 'sent',
  failed: 'failed',
  skipped: 'skipped',
};

export function outreachLine(lead) {
  if (!lead) return '';
  const label = OUTREACH_LABELS[lead.status] ?? lead.status ?? 'in the table';
  // relativeTime says "3h" one day and "Jul 30" the next, so it joins as its own
  // part rather than being read as a duration.
  const when = lead.ts ? relativeTime(lead.ts) : '';
  return ['outreach', label, when].filter(Boolean).join(' · ');
}

// ── The campaign panel ────────────────────────────────────────────────────

const percent = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '');

function stat(label, value, note) {
  const wrap = document.createElement('div');
  wrap.className = 'stat';
  const term = document.createElement('dt');
  term.className = 'stat-label';
  term.textContent = label;
  const figure = document.createElement('dd');
  figure.className = 'stat-value';
  figure.textContent = value;
  wrap.append(term, figure);
  if (note) {
    const line = document.createElement('div');
    line.className = 'stat-note';
    line.textContent = note;
    wrap.append(line);
  }
  return wrap;
}

export function statGrid(stats) {
  const fragment = document.createDocumentFragment();
  fragment.append(
    stat('Leads', String(stats.leads)),
    stat('Sent', String(stats.sent), percent(stats.sent, stats.leads) && `${percent(stats.sent, stats.leads)} of the table`),
    // An unread inbox is not a campaign nobody answered — the panel says which
    // one it is rather than printing a zero that reads as a result.
    stats.replied === null
      ? stat('Replied', '—', 'inbox not read yet')
      : stat('Replied', String(stats.replied), `${percent(stats.replied, stats.sent)} reply rate`),
    stat('Median reply', duration(stats.medianReplyLagMs)),
    stat('In this inbox', String(stats.captured), `of ${stats.sent} sent`),
  );
  return fragment;
}

/**
 * The funnel as a bar plus its legend. Stages nobody is in take no width — a bar
 * with six equal slivers would say the campaign is spread evenly when it is not.
 */
export function funnelBar(stages) {
  const fragment = document.createDocumentFragment();
  const total = STAGES.reduce((sum, s) => sum + (stages[s.id] ?? 0), 0);

  if (total) {
    const bar = document.createElement('div');
    bar.className = 'funnel-bar';
    for (const s of STAGES) {
      const count = stages[s.id] ?? 0;
      if (!count) continue;
      const segment = document.createElement('span');
      segment.className = 'funnel-seg';
      segment.dataset.stage = s.id;
      segment.style.flexGrow = String(count);
      segment.title = `${s.label} · ${count}`;
      bar.append(segment);
    }
    fragment.append(bar);
  }

  const legend = document.createElement('ul');
  legend.className = 'funnel-legend';
  for (const s of STAGES) {
    const count = stages[s.id] ?? 0;
    const item = document.createElement('li');
    item.className = count ? 'funnel-item' : 'funnel-item funnel-item-empty';
    const swatch = document.createElement('span');
    swatch.className = 'funnel-swatch';
    swatch.dataset.stage = s.id;
    const name = document.createElement('span');
    name.textContent = s.label;
    const number = document.createElement('span');
    number.className = 'funnel-count';
    number.textContent = String(count);
    item.append(swatch, name, number);
    legend.append(item);
  }
  fragment.append(legend);
  return fragment;
}

export function bubble(text, direction, meta, extra = '') {
  const label = messageLabel(text);
  const li = document.createElement('li');
  li.className = `bubble ${direction === 'out' ? 'out' : 'in'}${extra ? ` ${extra}` : ''}`;
  if (label !== text) li.classList.add('bubble-media'); // not something anyone typed
  li.textContent = label || '—';
  const time = document.createElement('span');
  time.className = 'bubble-time';
  time.textContent = meta;
  li.append(time);
  return li;
}
