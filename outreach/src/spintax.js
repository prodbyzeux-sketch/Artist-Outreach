// spintax.js — message templating, ported from Tabels' Swift engine.
//   1. applySpintax  — {a|b|c} → one option at random
//   2. personalize   — {token} → per-lead value ({username}, table columns, {name?})
//   3. table helpers — normalize headers into {token} keys, detect the handle column
//
// A message is rendered per lead as: personalize(applySpintax(template), vars).
// Spintax runs FIRST so a chosen option can itself contain {tokens}. Unknown
// tokens collapse to "" so a half-filled list never ships a literal "{token}".

// ── spintax ──────────────────────────────────────────────────────────────────
// Replace every {opt1|opt2|…} group with one random option. Loops so nested /
// sequential groups all resolve. Plain {name} vars (no "|") are left untouched.
export function applySpintax(text) {
  if (!text || !text.includes("|")) return text || "";
  const pattern = /\{([^{}]*\|[^{}]*)\}/;
  let result = text;
  let guard = 0;
  let m;
  while ((m = result.match(pattern)) && guard++ < 500) {
    const options = m[1].split("|");
    const chosen = options[Math.floor(Math.random() * options.length)] ?? "";
    result = result.slice(0, m.index) + chosen + result.slice(m.index + m[0].length);
  }
  return result;
}

// ── personalize ────────────────────────────────────────────────────────────────
// Substitute {token} placeholders from a lead's variable dict. `{username}` is a
// builtin (the handle); every other token comes from `vars` (table columns keyed
// by normalized header). `{name?}` is an OPTIONAL name: if empty it's removed with
// a neighbouring space so "Hey {name?}!" reads as "Hey!". Unknown tokens → "".
export function personalize(text, vars = {}) {
  let result = text || "";
  const name = (vars.name ?? "").trim();

  // {name?} — optional first name: substitute it, or if blank remove the token
  // together with a neighbouring space so "Hey {name?}!" reads as "Hey!".
  let optionalEmpty = false;
  if (result.includes("{name?}")) {
    if (name) {
      result = result.replaceAll("{name?}", name);
    } else {
      optionalEmpty = true;
      result = result.replace(/[ \t]*\{name\?\}/g, "");
    }
  }

  // Generic {token} pass. Keys match personalize's [a-zA-Z0-9_]+.
  result = result.replace(/\{([a-zA-Z0-9_]+)\}/g, (_full, key) => {
    if (key in vars) return vars[key] ?? "";
    if (key === "username") return vars.username ?? "";
    return ""; // unknown → empty, never leak the literal token
  });

  // Only tidy the artifacts an empty {name?} leaves — never rewrite spacing the
  // user typed elsewhere.
  if (optionalEmpty) {
    result = result.replace(/[ \t]{2,}/g, " ").replace(/ +([!?.,;:])/g, "$1").trim();
  }
  return result;
}

// ── table → variables ──────────────────────────────────────────────────────────
// Mirror of Swift `TableVariables`. A table is { headers, rows, matchColumn }.

// Only {username} is a builtin (the handle). A non-match "username" column would
// clash with it, so it's exposed as {table_username}. "name" is NOT reserved —
// unlike Tabels there's no live display-name parsing here, so a "name" column IS
// the source of {name}/{name?}.
const RESERVED = new Set(["username"]);

// Normalize a header: strip BOM, lowercase, non-alnum runs → "_", trim trailing
// "_". Returns null when nothing usable survives. This is the header's real
// name — detection matches on it, before any builtin gets out of the way.
function normalizeHeader(header) {
  const lowered = (header || "").replace(/﻿/g, "").trim().toLowerCase();
  let out = "";
  let lastSep = true;
  for (const ch of lowered) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      out += ch;
      lastSep = false;
    } else if (!lastSep) {
      out += "_";
      lastSep = true;
    }
  }
  out = out.replace(/_+$/, "");
  return out || null;
}

// The {token} key for a header. Reserved builtins get a "table_" prefix so the
// builtin keeps winning — a namespacing step, which is why detectMatchColumn
// below matches the normalized header instead: a column honestly called
// "username" is the likeliest handle column there is, and renaming it first
// made it the one name auto-detection could never find.
export function tableKey(header) {
  const out = normalizeHeader(header);
  if (!out) return null;
  return RESERVED.has(out) ? `table_${out}` : out;
}

// Normalize an IG reference (bare handle, @handle, or instagram.com URL) to a
// lowercase handle for matching and for navigation.
export function tableHandle(raw) {
  let s = (raw || "").replace(/﻿/g, "").trim();
  const idx = s.toLowerCase().indexOf("instagram.com/");
  if (idx >= 0) s = s.slice(idx + "instagram.com/".length);
  if (s.startsWith("@")) s = s.slice(1);
  const cut = s.search(/[/?#\s]/);
  if (cut >= 0) s = s.slice(0, cut);
  return s.toLowerCase();
}

// Auto-detect the IG-handle column by normalized header name. Never falls back to
// column 0 — a miss returns null (the UI shows a "pick the handle column" warning).
export function detectMatchColumn(headers) {
  const keys = (headers || []).map(normalizeHeader);
  for (const want of ["instagram", "ig", "username", "user", "handle", "profile"]) {
    const i = keys.indexOf(want);
    if (i >= 0) return i;
  }
  const c = keys.findIndex((k) => k && k.includes("instagram"));
  return c >= 0 ? c : null;
}

// Effective match column: stored override when in range, else auto-detection.
export function matchColumn(table) {
  const m = table?.matchColumn;
  if (Number.isInteger(m) && m >= 0 && m < (table.headers?.length || 0)) return m;
  return detectMatchColumn(table?.headers || []);
}

// [{ column, key }] for every non-match column. First header wins a key collision.
export function columnKeys(table) {
  const match = matchColumn(table);
  if (match == null) return [];
  const seen = new Set();
  const out = [];
  (table.headers || []).forEach((h, i) => {
    if (i === match) return;
    const k = tableKey(h);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push({ column: i, key: k });
  });
  return out;
}

// Every {token} the table exposes, for the UI's "available variables" chips.
export function tokenKeys(table) {
  return ["username", ...columnKeys(table).map((c) => c.key)];
}

// handle → { key: value, username }. Duplicate handles: first row wins. Empty
// cells produce no token. Rows are bounds-checked (ragged rows are tolerated).
export function buildLookup(table) {
  const match = matchColumn(table);
  if (match == null) return {};
  const columns = columnKeys(table);
  const out = {};
  for (const row of table.rows || []) {
    if (match >= row.length) continue;
    const h = tableHandle(row[match]);
    if (!h || out[h]) continue;
    const vars = { username: h };
    for (const { column, key } of columns) {
      if (column < row.length) {
        const v = (row[column] ?? "").trim();
        if (v) vars[key] = v;
      }
    }
    out[h] = vars;
  }
  return out;
}

// Unique handles in the match column (order preserved), for building the lead
// list. One table — see the list-level helpers below for the whole campaign.
export function tableHandles(table) {
  const match = matchColumn(table);
  if (match == null) return [];
  const seen = new Set();
  const out = [];
  for (const row of table.rows || []) {
    if (match >= row.length) continue;
    const h = tableHandle(row[match]);
    if (h && !seen.has(h)) {
      seen.add(h);
      out.push(h);
    }
  }
  return out;
}

// ── every table at once ───────────────────────────────────────────────────────
// A campaign may have several files loaded, and to everything downstream they
// are ONE audience: one queue, one set of {token}s, one lookup. Each keeps its
// own headers and its own handle column, so the files need nothing in common.
//
// A handle listed twice belongs to the table that mentioned it first — the same
// rule duplicate rows inside a single table already follow, so a re-import that
// overlaps an earlier file changes nothing rather than half-rewriting it.

export function allHandles(tables) {
  const seen = new Set();
  const out = [];
  for (const t of tables || []) {
    for (const h of tableHandles(t)) if (!seen.has(h)) { seen.add(h); out.push(h); }
  }
  return out;
}

export function allTokenKeys(tables) {
  const keys = new Set(["username"]);
  for (const t of tables || []) for (const k of tokenKeys(t)) keys.add(k);
  return [...keys];
}

export function mergedLookup(tables) {
  const out = {};
  for (const t of tables || []) {
    const one = buildLookup(t);
    for (const handle in one) if (!(handle in out)) out[handle] = one[handle];
  }
  return out;
}
