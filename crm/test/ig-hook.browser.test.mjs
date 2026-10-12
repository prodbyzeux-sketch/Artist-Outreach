// What the page-world hook keeps, and what it must refuse to keep.
//
//   node crm/test/ig-hook.browser.test.mjs
//
// Loads the REAL crm/content/ig-hook.js into a REAL headless Chrome and makes
// the page issue the three requests Instagram makes: the first page of the
// inbox, the next page of it, and one conversation's history. Two of those are
// replay templates the extension stores and re-sends later, and mixing them up
// is invisible until a refresh quietly starts reading the middle of the list.
//
// The regression this exists for: a pagination request carries a cursor, so it
// must never become the refresh template — but its RESPONSE is still full of
// conversations and must still be ingested.

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9431;
const SITE_PORT = 8795;
const HERE = path.dirname(fileURLToPath(import.meta.url));

const results = [];
const check = (name, pass, extra = "") =>
  results.push(`${pass ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><meta charset=utf-8>
<script>
  window.__seen = [];
  window.addEventListener('message', (e) => {
    if (e.data && e.data['ao-crm'] === true) window.__seen.push(e.data);
  });
  window.seen = (kind) => window.__seen.filter((m) => m.kind === kind);

  window.replay = (template) => new Promise((resolve) => {
    const id = 'r' + Math.random();
    const done = (e) => {
      if (!e.data || e.data.kind !== 'replay-result' || e.data.id !== id) return;
      window.removeEventListener('message', done);
      resolve(e.data.result);
    };
    window.addEventListener('message', done);
    window.postMessage({ 'ao-crm': true, kind: 'replay', id, template }, window.location.origin);
  });
<\/script>`;

/** The inbox payload, reduced to the marker the hook keys on. */
const INBOX = JSON.stringify({ data: { xdt_viewer: { inbox: { threads_by_folder: [{ thread_id: '1' }] } } } });
const THREAD = JSON.stringify({ thread: { viewer_id: '55501', items: [] } });
// One conversation, as this account's Instagram actually answers: the same
// `slide_messages` the mailbox uses, with no folder around it.
const CONVERSATION = JSON.stringify({
  data: {
    get_slide_thread_nullable: {
      as_ig_direct_thread: {
        thread_id: '111',
        slide_messages: { edges: [{ node: { id: 'm1' } }], page_info: { end_cursor: 'OLDER', has_next_page: true } },
      },
    },
  },
});

const log = [];
const site = http.createServer((req, res) => {
  log.push({ method: req.method, url: req.url, appID: req.headers['x-ig-app-id'] ?? null });
  if (req.url.startsWith('/api/')) {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.includes('/direct_v2/threads/')) res.end(THREAD);
    else res.end(req.url.includes('as=conversation') ? CONVERSATION : INBOX);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
await new Promise((resolve) => site.listen(SITE_PORT, '127.0.0.1', resolve));

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siluet-hook-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`,
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' });

async function pageTarget() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch (_e) { /* the port isn't up yet */ }
    await sleep(200);
  }
  throw new Error(`Chrome never opened a debugging port on ${PORT}`);
}

let socket = null;
let nextId = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  pending.set(++nextId, { resolve, reject });
  socket.send(JSON.stringify({ id: nextId, method, params }));
});

try {
  const target = await pageTarget();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (!m.id || !pending.has(m.id)) return;
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  };
  const evaluate = async (expression, awaitPromise = false) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })).result.value;

  const hookSource = fs.readFileSync(path.join(HERE, '..', 'content', 'ig-hook.js'), 'utf8');
  await send('Page.navigate', { url: `http://127.0.0.1:${SITE_PORT}/direct/inbox/` });
  await sleep(300);
  await evaluate(hookSource);
  check('the hook announces itself', (await evaluate("seen('hook-ready').length")) === 1);

  // ── the first page of the inbox: a template worth replaying ───────────────
  const firstBody = 'av=17841400000000000&doc_id=999&variables=%7B%22limit%22%3A20%7D';
  await evaluate(`fetch('/api/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-ig-app-id': '936619743392459' },
    body: ${JSON.stringify(firstBody)},
  }).then((r) => r.json()).then((j) => { window.__pageRead = j.data.xdt_viewer.inbox.threads_by_folder.length })`, true);
  await sleep(150);
  const inbox = await evaluate("seen('inbox')");
  check('an inbox response is reported', inbox.length === 1);
  check('  with the request kept as a replay template', inbox[0]?.template?.body === firstBody);
  check('  carrying the headers Instagram sent', inbox[0]?.template?.headers?.['x-ig-app-id'] === '936619743392459');
  check('  and the page still got to read its own body', (await evaluate('window.__pageRead')) === 1);

  // ── the next page: same response shape, but the request has a cursor ──────
  const pagingBody = 'av=17841400000000000&doc_id=777&fb_api_req_friendly_name=ThreadListPagination'
    + '&variables=%7B%22cursor%22%3A%22DEEP%22%2C%22limit%22%3A20%7D';
  await evaluate("window.__seen.length = 0; 1");
  await evaluate(`fetch('/api/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-ig-app-id': '936619743392459' },
    body: ${JSON.stringify(pagingBody)},
  })`, true);
  await sleep(150);
  const paged = await evaluate("seen('inbox')");
  const pageTemplate = await evaluate("seen('page-template')");
  check('a pagination response is still ingested — it is full of conversations', paged.length === 1);
  check('  but it is NEVER offered as the refresh template', paged[0]?.template === null,
    JSON.stringify(paged[0]?.template ?? null).slice(0, 60));
  check('  it is kept as the PAGINATION template instead', pageTemplate[0]?.template?.body === pagingBody);

  // ── ONE conversation over GraphQL: the mailbox's twin, and not the mailbox ─
  // The regression: `slide_messages` alone made this look like an inbox answer,
  // so opening any conversation replaced the refresh template with a request for
  // that one conversation — and every later refresh re-read it and reported
  // success.
  await evaluate("window.__seen.length = 0; 1");
  const threadQueryBody = 'av=17841400000000000&doc_id=555&variables=%7B%22threadID%22%3A%22111%22%2C%22cursor%22%3Anull%7D';
  await evaluate(`fetch('/api/graphql?as=conversation', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-ig-app-id': '936619743392459' },
    body: ${JSON.stringify(threadQueryBody)},
  })`, true);
  await sleep(150);
  check('one conversation is never reported as an inbox answer', (await evaluate("seen('inbox')")).length === 0);
  const graphThread = await evaluate("seen('thread')");
  check('  it is reported as a conversation', graphThread.length === 1);
  check('  and its request is kept, so another conversation can be asked for',
    graphThread[0]?.template?.body === threadQueryBody);

  // ── a conversation over the old REST endpoint ─────────────────────────────
  await evaluate("window.__seen.length = 0; 1");
  await evaluate("fetch('/api/v1/direct_v2/threads/111/?limit=20', { headers: { 'x-ig-app-id': '936619743392459' } })", true);
  await sleep(150);
  const thread = await evaluate("seen('thread')");
  check('a conversation response is reported', thread.length === 1);
  check('  with its url kept, so it can be pointed at another thread',
    thread[0]?.template?.url?.includes('/api/v1/direct_v2/threads/111/') === true);
  check('  and its headers, which is what makes the replay authorised',
    thread[0]?.template?.headers?.['x-ig-app-id'] === '936619743392459');
  check('  and it is not mistaken for an inbox response', (await evaluate("seen('inbox')")).length === 0);

  // ── replay: a template with no body is the GET one ────────────────────────
  log.length = 0;
  const got = await evaluate(`replay({
    url: '/api/v1/direct_v2/threads/222/?limit=20',
    headers: { 'x-ig-app-id': '936619743392459' },
  })`, true);
  check('a body-less template replays as a GET', log[0]?.method === 'GET', `${log[0]?.method} ${log[0]?.url}`);
  check('  at the thread it was pointed at', log[0]?.url === '/api/v1/direct_v2/threads/222/?limit=20');
  check('  with the captured headers', log[0]?.appID === '936619743392459');
  check('  and the body comes back to the extension', got?.status === 200 && got.body === THREAD);

  log.length = 0;
  const posted = await evaluate(`replay({ url: '/api/graphql', headers: {}, body: ${JSON.stringify(firstBody)} })`, true);
  check('a template with a body still replays as a POST', log[0]?.method === 'POST', String(log[0]?.method));
  check('  and answers with the inbox', posted?.status === 200 && posted.body === INBOX);

  // ── a replay must not be captured as traffic of its own ───────────────────
  await evaluate("window.__seen.length = 0; 1");
  await evaluate(`replay({ url: '/api/graphql', headers: {}, body: ${JSON.stringify(firstBody)} })`, true);
  await sleep(150);
  check('a replay is not re-captured as a fresh template', (await evaluate("seen('inbox')")).length === 0);
} finally {
  if (socket) socket.close();
  chrome.kill();
  site.close();
  fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

console.log(results.join('\n'));
const ok = results.every((r) => r.startsWith('PASS'));
console.log(ok ? 'ALL PASS' : 'SOME FAILED');
process.exit(ok ? 0 : 1);
