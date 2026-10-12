#!/usr/bin/env node
// siluet-bridge — local HTTP bridge between the siluet CRM extension and any
// tool on this machine (Claude Code, curl, a script). Same shape as
// praythreads-bridge, with the read direction added.
//
//   CRM page  --POST /sync-----▶  this daemon  ◀--GET /snapshot--  Claude
//             ◀--GET /pending--                ◀--POST /commands--
//             --POST /ack-----▶
//
// One daemon, many CRMs: every browser and every Chrome profile has its own
// storage, its own Instagram account and its own CRM tab on this socket. So a
// snapshot belongs to a source, and a command names its target — see lib/routing.js.
//
// Nothing here reaches into Chrome: the extension pushes and polls. The socket
// is bound to 127.0.0.1, which keeps the network out — but not the browser, so
// every request also has to come from a caller with no Origin (a tool on this
// machine) or from the extension itself. See lib/intake.js.
//
// Zero dependencies (Node built-ins only). Run it and leave it running:
//   node bridge/siluet-bridge.mjs
//
// Read one account's inbox:
//   curl -s 'localhost:8788/snapshot?account=prayangelica' | jq '.threadCount'
//
// Write a stage back onto a lead in that account:
//   curl -s localhost:8788/commands -H 'content-type: application/json' \
//     -d '{"account":"prayangelica","commands":[{"type":"patch","threadID":"3402…","fields":{"stage":"pitched"}}]}'

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { matchesSource, pickSnapshot, describeSource, countUnroutable, addressedTo } from '../lib/routing.js';
import { allowsOrigin, normalizeCommand } from '../lib/intake.js';

const PORT = Number(process.env.SILUET_BRIDGE_PORT || 8788);
const HOST = '127.0.0.1';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_FILE = path.join(__dirname, 'queue.json');
const SNAPSHOT_FILE = path.join(__dirname, 'snapshots.json');

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJson(file, value) {
  try { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
  catch (e) { console.error(`[bridge] write to ${path.basename(file)} failed:`, e.message); }
}

const loadedQueue = loadJson(QUEUE_FILE, []);
let queue = Array.isArray(loadedQueue) ? loadedQueue : [];
/** sourceId → snapshot. One entry per connected CRM tab. */
let snapshots = loadJson(SNAPSHOT_FILE, {}) ?? {};

/**
 * Answer only the origin that was let in — never `*`. A wildcard here hands the
 * operator's whole inbox to any page they happen to have open.
 */
function cors(res, origin) {
  if (!origin) return; // a tool on this machine; CORS is a browser concept
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Vary', 'Origin');
}
function sendJson(res, code, obj, origin) {
  cors(res, origin);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    // A full inbox with history is megabytes — the cap is generous, not absent.
    req.on('data', (c) => { b += c; if (b.length > 64e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin ?? '';
  // The door. A page cannot forge Origin, and a POST with a plain content-type
  // needs no preflight — so refusing here, before anything is read or written,
  // is what actually stops a website from driving this daemon.
  if (!allowsOrigin(origin)) {
    console.warn(`[bridge] refused ${req.method} ${req.url} from ${origin}`);
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'origin not allowed' }));
  }
  const reply = (code, obj) => sendJson(res, code, obj, origin);

  if (req.method === 'OPTIONS') { cors(res, origin); res.writeHead(204); res.end(); return; }

  let url;
  try { url = new URL(req.url, `http://${HOST}:${PORT}`); }
  catch { return reply(400, { ok: false, error: 'bad url' }); }
  const query = {
    source: url.searchParams.get('source') ?? '',
    account: url.searchParams.get('account') ?? '',
  };

  if (req.method === 'GET' && url.pathname === '/health') {
    return reply(200, {
      ok: true,
      port: PORT,
      pending: queue.length,
      // Queued for somebody who isn't here: a mistyped account, or a profile
      // that stopped polling. Nothing else on this machine mentions those.
      unroutable: countUnroutable(queue, snapshots),
      sources: Object.values(snapshots).map(describeSource),
    });
  }
  if (req.method === 'GET' && url.pathname === '/sources') {
    return reply(200, { sources: Object.values(snapshots).map(describeSource) });
  }

  // ── read: each CRM pushes its own, readers name which one ───────────────
  if (req.method === 'POST' && url.pathname === '/sync') {
    const body = await readBody(req);
    const sourceId = typeof body?.sourceId === 'string' ? body.sourceId.trim() : '';
    if (!sourceId) return reply(400, { ok: false, error: 'no sourceId' });
    if (!Array.isArray(body?.threads)) return reply(400, { ok: false, error: 'no threads array' });

    snapshots[sourceId] = { ...body, capturedAt: Date.now() };
    saveJson(SNAPSHOT_FILE, snapshots);
    const who = describeSource(snapshots[sourceId]);
    console.log(`[bridge] snapshot ← ${who.account ?? sourceId}: ${body.threads.length} threads`);
    return reply(200, { ok: true, threads: body.threads.length });
  }
  if (req.method === 'GET' && url.pathname === '/snapshot') {
    const { snapshot, error, choices } = pickSnapshot(snapshots, query);
    if (snapshot) return reply(200, snapshot);
    // 409, not 200-with-the-newest: reading the wrong account silently is the
    // one failure nothing downstream can catch.
    return reply(error === 'ambiguous' ? 409 : 404, { ok: false, error, choices });
  }

  // A CRM tab that will never come back — a closed profile, or the standalone
  // extension after switching to the suite — keeps its snapshot here forever,
  // and a second live source turns every unaddressed read into a 409. There is
  // no honest way to time this out: a real tab can sit quiet for hours and its
  // snapshot is still the truth. So it is a deliberate act.
  //
  // It takes the commands sent to that address with it. A command is an
  // intention with a target, and one whose target never existed — a typo — has
  // no other way out of the queue.
  if (req.method === 'POST' && url.pathname === '/forget') {
    const body = await readBody(req);
    const target = { source: String(body?.source ?? ''), account: String(body?.account ?? '') };
    if (!target.source && !target.account) return reply(400, { ok: false, error: 'name a source or an account' });
    const gone = Object.entries(snapshots)
      .filter(([, snapshot]) => matchesSource(target, snapshot))
      .map(([sourceId]) => sourceId);
    for (const sourceId of gone) delete snapshots[sourceId];
    if (gone.length) saveJson(SNAPSHOT_FILE, snapshots);

    const before = queue.length;
    queue = queue.filter((c) => !addressedTo(c, target));
    const dropped = before - queue.length;
    if (dropped) saveJson(QUEUE_FILE, queue);

    console.log(`[bridge] forgot ${gone.length} source(s) and ${dropped} command(s): ${gone.join(', ') || '—'}`);
    const found = gone.length + dropped;
    return reply(found ? 200 : 404, { ok: found > 0, forgot: gone, commands: dropped });
  }

  // ── write: readers queue, the addressed CRM drains ──────────────────────
  if (req.method === 'POST' && url.pathname === '/commands') {
    const body = await readBody(req);
    const raw = Array.isArray(body?.commands) ? body.commands : [body];
    const results = raw.map((c) => normalizeCommand(c, body));
    const accepted = results.map((r) => r.command).filter(Boolean);
    if (!accepted.length) {
      // The reason, not just "no". A command refused in silence is one the
      // sender waits on forever, watching a queue that never had it.
      return reply(400, { ok: false, error: 'no valid commands', refused: results.map((r) => r.error) });
    }
    queue.push(...accepted);
    saveJson(QUEUE_FILE, queue);
    const refused = results.filter((r) => r.error).map((r) => r.error);
    console.log(`[bridge] queued ${accepted.length} command(s), ${queue.length} pending`);
    return reply(200, { ok: true, accepted: accepted.length, pending: queue.length, refused });
  }
  if (req.method === 'GET' && url.pathname === '/pending') {
    if (!query.source) return reply(400, { ok: false, error: 'no source' });
    const asking = snapshots[query.source] ?? { sourceId: query.source, viewer: null };
    return reply(200, { commands: queue.filter((c) => matchesSource(c, asking)) });
  }
  if (req.method === 'POST' && url.pathname === '/ack') {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const before = queue.length;
    queue = queue.filter((c) => !ids.includes(c.id));
    saveJson(QUEUE_FILE, queue);
    return reply(200, { ok: true, removed: before - queue.length, pending: queue.length });
  }

  reply(404, { ok: false, error: 'not found' });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[bridge] port ${PORT} is busy — another bridge is already running, or set SILUET_BRIDGE_PORT.`);
    process.exit(1);
  }
  console.error('[bridge] server error:', e.message);
});

server.listen(PORT, HOST, () => {
  const known = Object.values(snapshots).map((s) => describeSource(s).account ?? s.sourceId);
  console.log(`[bridge] http://${HOST}:${PORT}  ${QUEUE_FILE} (${queue.length} pending)`);
  console.log(`[bridge] sources: ${known.length ? known.join(', ') : 'none yet — open a CRM tab'}`);
});
