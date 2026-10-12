// dashboard.js — what came of the sending. Reads the leads and the reply facts
// captured from Instagram's own inbox traffic (src/inbox.js), runs them through
// the pure aggregations in src/stats.js, and draws.
//
// Every number here is honest about its sample: a reply rate off three sends is
// noise, and the panel says so rather than printing a confident percentage.

import { getLeads, getInbox, getMessages, getProfile, get, KEYS } from "../storage.js";
import { outcomes, headline, byOpener, byPath, byHour, bestHour, activityGrid, heatLevel, MIN_SAMPLE }
  from "../stats.js";
import { $ } from "./dom.js";

const pct = (v) => `${Math.round(v * 100)}%`;
const WEEKDAYS = ["", "Mon", "", "Wed", "", "Fri", ""];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function humanDuration(ms) {
  if (ms == null) return "—";
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

function statTile(label, value, sub) {
  const box = document.createElement("div");
  box.className = "stat";
  const v = document.createElement("div");
  v.className = "stat-value";
  v.textContent = value;
  const l = document.createElement("div");
  l.className = "stat-label";
  l.textContent = label;
  box.append(v, l);
  if (sub) {
    const s = document.createElement("div");
    s.className = "stat-sub muted";
    s.textContent = sub;
    box.append(s);
  }
  return box;
}

// A rate plus the sample it rests on. Below MIN_SAMPLE the bar is drawn faint
// and the count is spelled out, so a 100%-off-two never reads as a finding.
function rateRow(label, row, title) {
  const el = document.createElement("div");
  el.className = "rate" + (row.sent < MIN_SAMPLE ? " rate--thin" : "");
  const name = document.createElement("span");
  name.className = "rate-name";
  name.textContent = label;
  if (title) name.title = title;
  const bar = document.createElement("span");
  bar.className = "rate-bar";
  const fill = document.createElement("span");
  fill.style.width = `${Math.round(row.rate * 100)}%`;
  bar.append(fill);
  const num = document.createElement("span");
  num.className = "rate-num";
  num.textContent = `${pct(row.rate)}  ${row.replied}/${row.sent}`;
  el.append(name, bar, num);
  return el;
}

function renderGrid(grid) {
  const wrap = $("activityGrid");
  wrap.innerHTML = "";

  const months = document.createElement("div");
  months.className = "grid-months";
  let lastMonth = -1;
  grid.columns.forEach((col) => {
    const m = new Date(col[0].date).getMonth();
    const cell = document.createElement("span");
    // Label a column only when its week opens a new month, GitHub-style.
    cell.textContent = m !== lastMonth ? MONTHS[m] : "";
    lastMonth = m;
    months.append(cell);
  });

  const body = document.createElement("div");
  body.className = "grid-body";

  const days = document.createElement("div");
  days.className = "grid-days";
  WEEKDAYS.forEach((d) => { const s = document.createElement("span"); s.textContent = d; days.append(s); });

  const cols = document.createElement("div");
  cols.className = "grid-cols";
  for (const col of grid.columns) {
    const c = document.createElement("div");
    c.className = "grid-col";
    for (const day of col) {
      const sq = document.createElement("span");
      const level = day.future ? 0 : heatLevel(day.sent, grid.busiest);
      sq.className = `sq sq--${level}` + (day.future ? " sq--future" : "");
      const date = new Date(day.date).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
      sq.title = day.future ? date
        : `${day.sent || "no"} send${day.sent === 1 ? "" : "s"}${day.replied ? `, ${day.replied} replied` : ""} · ${date}`;
      c.append(sq);
    }
    cols.append(c);
  }
  body.append(days, cols);

  const legend = document.createElement("div");
  legend.className = "grid-legend muted";
  const less = document.createElement("span");
  less.textContent = "Less";
  legend.append(less);
  for (let i = 0; i <= 4; i++) { const s = document.createElement("span"); s.className = `sq sq--${i}`; legend.append(s); }
  const more = document.createElement("span");
  more.textContent = "More";
  legend.append(more);

  wrap.append(months, body, legend);
  $("gridTotal").textContent = `${grid.total} send${grid.total === 1 ? "" : "s"} in the last year`;
}

function renderHours(buckets, best) {
  const wrap = $("hourChart");
  wrap.innerHTML = "";
  const peak = Math.max(1, ...buckets.map((b) => b.sent));
  for (const b of buckets) {
    const col = document.createElement("div");
    col.className = "hour" + (best.hour === b.hour ? " hour--best" : "");
    const bar = document.createElement("span");
    bar.className = "hour-bar";
    // Height is the volume, fill is the reply rate — one column answers both
    // "did we send then" and "did it land".
    bar.style.height = `${Math.max(2, Math.round((b.sent / peak) * 46))}px`;
    const fill = document.createElement("span");
    fill.style.height = `${Math.round(b.rate * 100)}%`;
    bar.append(fill);
    const lab = document.createElement("span");
    lab.className = "hour-label";
    lab.textContent = b.hour % 6 === 0 ? String(b.hour) : "";
    col.title = `${b.hour}:00 — ${b.sent} sent, ${b.replied} replied${b.sent ? ` (${pct(b.rate)})` : ""}`;
    col.append(bar, lab);
    wrap.append(col);
  }
  $("bestHour").textContent = best.hour == null
    ? best.reason
    : `Best hour so far: ${String(best.hour).padStart(2, "0")}:00 — ${pct(best.rate)} of ${best.sent} replied`;
}

// Who these numbers belong to. The avatar is the copy the worker kept at the
// last run (keepAvatar) — Instagram's own URLs are signed and expire, so the
// live URL is only a fallback, and initials are the fallback for that.
function renderWho(profile) {
  const box = $("whoCard");
  box.innerHTML = "";
  if (!profile || !profile.username) {
    box.className = "who who--empty";
    box.textContent = "The sending account is read at the start of a run.";
    return;
  }
  box.className = "who";

  const initials = document.createElement("span");
  initials.className = "who-initials";
  initials.textContent = profile.username.slice(0, 2).toUpperCase();

  const src = profile.avatarData || profile.avatar;
  if (src) {
    const img = document.createElement("img");
    img.className = "who-avatar";
    img.src = src;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => img.replaceWith(initials));
    box.append(img);
  } else {
    box.append(initials);
  }

  const text = document.createElement("div");
  text.className = "who-text";
  const name = document.createElement("div");
  name.className = "who-name";
  name.textContent = profile.fullName || `@${profile.username}`;
  const handle = document.createElement("div");
  handle.className = "who-handle muted";
  handle.textContent = `@${profile.username}`;
  text.append(name, handle);
  if (profile.bio) {
    const bio = document.createElement("div");
    bio.className = "who-bio muted";
    bio.textContent = profile.bio;
    text.append(bio);
  }
  box.append(text);

  if (profile.followers != null) {
    const counts = document.createElement("div");
    counts.className = "who-counts muted";
    counts.textContent = `${profile.followers.toLocaleString()} followers`
      + (profile.posts != null ? ` · ${profile.posts.toLocaleString()} posts` : "");
    box.append(counts);
  }
}

export async function renderDashboard() {
  const [leads, inbox, messages, scannedAt, profile] = await Promise.all([
    getLeads(), getInbox(), getMessages(), get(KEYS.inboxScannedAt, 0), getProfile(),
  ]);
  renderWho(profile);

  const rows = outcomes(leads, inbox);
  const head = headline(rows);

  const stats = $("statRow");
  stats.innerHTML = "";
  stats.append(
    statTile("sent", String(head.sent)),
    statTile("replied", String(head.replied)),
    statTile("reply rate", head.sent ? pct(head.rate) : "—",
      head.sent && head.sent < MIN_SAMPLE ? `only ${head.sent} sends so far` : ""),
    statTile("median reply", humanDuration(head.medianReplyLagMs)),
    // "threads read", not "conversations read": five tiles share one row, and
    // the longer label was the only one wrapping to two lines.
    statTile("threads read", String(Object.keys(inbox).length)),
  );

  const openers = byOpener(rows, messages);
  const openerBox = $("openerRates");
  openerBox.innerHTML = "";
  if (!openers.length) {
    openerBox.append(Object.assign(document.createElement("p"), {
      className: "muted", textContent: "Nothing sent yet — openers appear here once a run has gone out.",
    }));
  } else {
    for (const o of openers) {
      const short = o.text.length > 60 ? o.text.slice(0, 58) + "…" : o.text;
      openerBox.append(rateRow(short.replace(/\s+/g, " "), o, o.text));
    }
  }

  const paths = byPath(rows);
  const pathBox = $("pathRates");
  pathBox.innerHTML = "";
  for (const p of paths) pathBox.append(rateRow(p.format, p));
  $("pathBlock").hidden = paths.length < 2;

  renderGrid(activityGrid(leads, inbox));
  const buckets = byHour(rows);
  renderHours(buckets, bestHour(buckets));

  $("inboxAge").textContent = scannedAt
    ? `inbox last read ${new Date(scannedAt).toLocaleString()}`
    : "the inbox has not been read yet — it happens at the start of every run";
}

// Reading the inbox needs a real Instagram page with the driver attached, so
// this opens the work window the same way a run does — just unfocused, and
// without sending anything. It closes itself when it's done.
export function setRefreshing(busy) {
  const btn = $("refreshInbox");
  btn.disabled = busy;
  btn.textContent = busy ? "reading…" : "Reread the inbox";
}

export function initDashboard() {
  $("refreshInbox").addEventListener("click", () => {
    setRefreshing(true);
    chrome.runtime.sendMessage({ type: "REFRESH_INBOX" });
  });
  renderDashboard();
}
