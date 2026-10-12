// Does a run stop by itself when the work is done?
//
//   node test/run-lifecycle.test.mjs
//
// Drives the REAL src/background.js against a stub of the chrome APIs it uses:
// START goes in, leads come back "sent", and the test then asks the questions
// the user asks — is the button back to Start, is the work window closed, is the
// debugger off my browser, is there an alarm still waiting to wake a finished
// run? Three shapes of ending are covered: the queue running out, the queue
// running out EARLY (leads skipped by hand while the run was counting on them),
// and maxPerRun.
//
// The alarm stub fires on a 5ms timer instead of the requested minutes, so a run
// with a 30-90s pause between leads takes milliseconds here.

const results = [];
const check = (name, pass, extra = "") =>
  results.push(`${pass ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the platform ──────────────────────────────────────────────────────────────
// A run now needs a connected Artist Outreach account and takes one unit of the
// day's DM allowance before every send (platform/quota.js). This stands in for
// the server: `limit` null is Pro (unlimited), a number is Starter's cap.
const PLATFORM = { limit: null, used: 0, access: true, claims: 0, releases: 0 };
const resetPlatform = (p = {}) => Object.assign(PLATFORM, { limit: null, used: 0, access: true, claims: 0, releases: 0 }, p);
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url).pathname;
  if (!PLATFORM.access) return reply({ success: false, error: "subscription_required" }, 402);
  const left = () => (PLATFORM.limit == null ? null : Math.max(0, PLATFORM.limit - PLATFORM.used));
  if (path === "/ext/v1/quota") return reply({ success: true, plan: PLATFORM.limit == null ? "pro" : "starter", day: "2026-10-12", used: PLATFORM.used, limit: PLATFORM.limit, remaining: left() });
  if (path === "/ext/v1/quota/claim") {
    PLATFORM.claims++;
    if (PLATFORM.limit != null && PLATFORM.used >= PLATFORM.limit) return reply({ success: true, ok: false, error: "daily_limit", day: "2026-10-12", used: PLATFORM.used, limit: PLATFORM.limit, remaining: 0 });
    PLATFORM.used++;
    return reply({ success: true, ok: true, day: "2026-10-12", used: PLATFORM.used, limit: PLATFORM.limit, remaining: left() });
  }
  if (path === "/ext/v1/quota/release") { PLATFORM.releases++; PLATFORM.used = Math.max(0, PLATFORM.used - 1); return reply({ success: true, released: true }); }
  return reply({ success: false, error: "not_found" }, 404);
};

// Does `want` follow every event `match` picks out of the trace? "It happened at
// some point" is not the question: each of those events is a place the page was
// thrown away, so each one needs its own recovery after it.
const afterEach = (trace, match, want) =>
  trace.some(match) && trace.every((e, i) => !match(e) || trace.slice(i + 1).includes(want));

// ── the stub ──────────────────────────────────────────────────────────────────
// Every scenario re-imports background.js under a fresh query string, but the
// modules IT imports — cdp.js among them — are the same instances all the way
// through the process. So cdp.js registers its chrome.debugger.onEvent listener
// exactly once, into the FIRST harness, and a later scenario firing events at
// its own listeners.event array fires them at nobody. Debugger events therefore
// go to this shared list. (cdp.js reads `chrome` off the global when it acts, so
// its commands still land in the harness that is current.)
const debuggerListeners = [];
// The leads, the messages, the follow-up steps and the settings belong to a
// CAMPAIGN (src/storage.js), so the store is seeded the way a browser that has
// been through the update holds them — and the run is checked at the key the
// worker actually writes, not at the one it used to.
const CAMPAIGN = "c_test";
const LEADS_KEY = `leads:${CAMPAIGN}`;

function makeChrome({ leads, settings, onSend, followups = [], inbox = {}, avatar = "",
                     avatarBytes = "", granted = true, connected = true }) {
  const store = {
    ...(connected ? { aoPlatform: { origin: "http://localhost:3456", token: "t".repeat(40), email: "test@example.com" } } : {}),
    campaigns: [{ id: CAMPAIGN, name: "Campaign 1", createdAt: 0 }],
    activeCampaign: CAMPAIGN,
    [LEADS_KEY]: leads,
    [`settings:${CAMPAIGN}`]: settings,
    [`followups:${CAMPAIGN}`]: followups,
    [`messages:${CAMPAIGN}`]: [{ id: "m1", text: "hello {username}" }],
    [`table:${CAMPAIGN}`]: null,
    inbox,
  };
  const log = [];
  const alarms = new Map();
  const listeners = { message: [], alarm: [], detach: [], event: [], updated: [] };
  const windows = new Map();
  let nextId = 100;

  // `trace` is the ordered story of what the worker did to the page: every
  // navigation, every reload, and every time it told Chrome to keep rendering
  // the window. Order is the whole point — a window that stops rendering when it
  // goes off screen is a run that stands still there, so what matters is not
  // that the override was ever sent but that one follows each of the events that
  // could have dropped it.
  const state = { attached: null, windowsClosed: 0, sends: 0, navigations: [], payloads: [], hands: [],
                  abandons: 0, trace: [], pulled: [], fetch: [] };

  const chrome = {
    runtime: {
      id: "test",
      getURL: (p) => "chrome-extension://test/" + p,
      lastError: null,
      sendMessage: async (msg) => { log.push(msg); return undefined; },
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
    },
    storage: {
      local: {
        get: async (key) => (key in store ? { [key]: store[key] } : {}),
        set: async (obj) => { Object.assign(store, obj); },
        remove: async (key) => { delete store[key]; },
      },
    },
    alarms: {
      create: (name, info) => {
        // Real delay ignored: what is being tested is whether an alarm is left
        // behind, not how long it waits.
        const t = setTimeout(() => {
          if (!alarms.has(name)) return;
          alarms.delete(name);
          listeners.alarm.forEach((fn) => fn({ name }));
        }, 5);
        alarms.set(name, { info, t });
      },
      clear: (name) => {
        const a = alarms.get(name);
        if (a) clearTimeout(a.t);
        alarms.delete(name);
        return Promise.resolve(true);
      },
      get: async (name) => (alarms.has(name) ? { name } : undefined),
      onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
      pending: () => [...alarms.keys()],
      __map: alarms,
    },
    tabs: {
      query: async () => [],
      create: async () => ({ id: ++nextId }),
      update: async (_id, props) => {
        if (props && props.url) { state.navigations.push(props.url); state.trace.push(`nav:${props.url}`); }
        return {};
      },
      get: async (id) => {
        if (!windows.has(id)) throw new Error(`No tab with id: ${id}`);
        return { id, status: "complete" };
      },
      onUpdated: { addListener: (fn) => listeners.updated.push(fn), removeListener: () => {} },
      sendMessage: async (tabId, msg) => {
        if (!windows.has(tabId)) throw new Error("Could not establish connection.");
        if (msg.type === "PING") return { ok: true, url: "https://instagram.com/direct/inbox/", w: 1280, h: 800 };
        if (msg.type === "HANDS") { state.hands.push(msg.on); return { ok: true }; }
        if (msg.type === "ABANDON") { state.abandons++; return { ok: true }; }
        if (msg.type === "SCAN_INBOX") return { ok: true };
        // The page loading something the worker wants the bytes of. Real Chrome
        // then pauses that response for the debugger, which is where cdp.js is
        // waiting — so the stub has to do that too, or nothing is ever captured.
        if (msg.type === "PULL") {
          state.pulled.push(msg.url);
          if (!avatarBytes) return { ok: false, error: "net::ERR_FAILED" };
          for (const fn of debuggerListeners) {
            fn({ tabId }, "Fetch.requestPaused", {
              requestId: "img1",
              request: { url: msg.url },
              responseHeaders: [{ name: "content-type", value: "image/jpeg" }],
            });
          }
          return { ok: true };
        }
        if (msg.type === "OWN_PROFILE") return { ok: true, profile: { username: "me", avatar } };
        if (msg.type === "SEND") {
          state.sends++; state.trace.push("send"); state.payloads.push(msg.payload);
          return onSend(msg.payload, state.sends);
        }
        return undefined;
      },
    },
    windows: {
      create: async ({ url }) => {
        const tabId = ++nextId;
        windows.set(tabId, { url });
        state.workTab = tabId;
        return { id: tabId, tabs: [{ id: tabId }] };
      },
      get: async (id) => {
        if (!windows.has(id)) throw new Error("No window with id");
        return { id };
      },
      update: async () => ({}),
      remove: async (id) => { windows.delete(id); state.windowsClosed++; },
      open: () => [...windows.keys()],
    },
    scripting: { executeScript: async () => [] },
    debugger: {
      attach: async ({ tabId }) => { state.attached = tabId; },
      detach: async () => { state.attached = null; },
      sendCommand: async (_target, method, params) => {
        if (method === "Emulation.setFocusEmulationEnabled" && params && params.enabled) {
          state.trace.push("keeprendering");
        }
        if (method === "Fetch.getResponseBody") return { body: avatarBytes, base64Encoded: true };
        // A left-on interception hangs every request that matches it, so which
        // of these was called and when is part of what the avatar owes.
        if (method === "Fetch.enable" || method === "Fetch.disable" || method === "Fetch.continueRequest") {
          state.fetch.push(method.slice(6).toLowerCase());
        }
        return {};
      },
      onDetach: { addListener: (fn) => listeners.detach.push(fn) },
      onEvent: { addListener: (fn) => { listeners.event.push(fn); debuggerListeners.push(fn); } },
    },
    action: { onClicked: { addListener: () => {} } },
    notifications: {
      create: async (opts) => { state.notices.push(opts); return "n1"; },
      onClicked: { addListener: () => {} },
    },
    permissions: { contains: async () => granted, onAdded: { addListener: () => {} } },
  };
  state.notices = [];

  return { chrome, store, log, listeners, state, alarms: chrome.alarms, windows: chrome.windows };
}

const LEADS = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: `l${i}`, handle: `lead${i}`, status: "pending", source: "manual" }));

const SETTINGS = {
  formatJustDM: true, maxPerRun: 0, skipExisting: false,
  perLeadDelayMin: 30000, perLeadDelayMax: 90000, typingSpeed: 1,
};

// Wait until the run says it is over, or give up. Nothing here polls a clock the
// run controls — the point is whether it ever stops at all.
// The first Start of a scenario is easy to wait for: nothing has run yet, so
// settle() cannot mistake anything for the ending. A SECOND Start has to be seen
// starting first, or settle() looks at the finished run's leftovers and reports
// the new one already over.
async function began(harness, ms = 5000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (harness.store.runState?.running) return true;
    await sleep(5);
  }
  return false;
}

async function settle(harness, ms = 25000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const st = harness.store.runState;
    if (st && !st.running && harness.windows.open().length === 0 && !harness.alarms.pending().length) return true;
    await sleep(25);
  }
  return false;
}

async function run({ leadCount, settings = SETTINGS, onSend, prepare, extraLeads = [], followups = [],
                     avatar = "", avatarBytes = "", granted = true, connected = true, platform = {} }) {
  resetPlatform(platform);
  const leads = [...LEADS(leadCount), ...extraLeads];
  const harness = makeChrome({ leads, settings, onSend, followups, avatar, avatarBytes, granted, connected });
  globalThis.chrome = harness.chrome;
  // Fresh module per scenario: background.js keeps run state in module scope.
  await import(`../src/background.js?${Math.random()}`);
  const fire = (msg) => harness.listeners.message[0](msg, {}, () => {});
  fire({ type: "START" });
  if (prepare) await prepare(harness);
  const stopped = await settle(harness);
  return { harness, stopped };
}

const sent = () => ({ status: "sent", threadId: "t1" });

// 1. The ordinary ending: every lead in the queue is done.
{
  const { harness, stopped } = await run({ leadCount: 4, onSend: sent });
  check("a finished queue stops the run", stopped);
  check("  runState.running is false", harness.store.runState?.running === false,
    JSON.stringify({ running: harness.store.runState?.running, phase: harness.store.runState?.phase }));
  check("  no step alarm is left waiting", harness.alarms.pending().length === 0,
    harness.alarms.pending().join(","));
  check("  the work window is closed", harness.windows.open().length === 0);
  check("  the debugger is detached", harness.state.attached === null);
  check("  every lead was sent", harness.state.sends === 4, `${harness.state.sends} sends`);
  check("  and the log says so",
    harness.log.some((m) => m.type === "LOG" && /^done — sent 4/.test(m.text)),
    harness.log.filter((m) => m.type === "LOG").slice(-3).map((m) => m.text).join(" | "));
  // The invariant that keeps a run alive on another desktop: nothing is ever
  // typed into a window that has not just been told to go on rendering.
  check("  every lead is worked with the rendering override in place",
    harness.state.trace.filter((e) => e === "send").length === 4
    && harness.state.trace.every((e, i) => e !== "send" || harness.state.trace[i - 1] === "keeprendering"),
    harness.state.trace.join(" → "));
}

// 2. The queue runs out EARLY: the run was told there were 5, and finds 2.
//    This is "лиды кончились" — the count it is holding no longer matches.
{
  const { harness, stopped } = await run({
    leadCount: 5,
    onSend: sent,
    prepare: async (h) => {
      await sleep(60);   // after the run has published total: 5
      h.store[LEADS_KEY] = h.store[LEADS_KEY].map((l, i) => (i > 1 ? { ...l, removed: true } : l));
    },
  });
  check("a queue that empties early stops the run", stopped);
  check("  runState.running is false", harness.store.runState?.running === false);
  check("  the work window is closed", harness.windows.open().length === 0);
  check("  no step alarm is left waiting", harness.alarms.pending().length === 0);
}

// 3. maxPerRun is the ending.
{
  const { harness, stopped } = await run({
    leadCount: 6, settings: { ...SETTINGS, maxPerRun: 2 }, onSend: sent,
  });
  check("maxPerRun stops the run", stopped);
  check("  it stopped at the cap", harness.state.sends === 2, `${harness.state.sends} sends`);
  check("  the work window is closed", harness.windows.open().length === 0);
}

// 4. Stop pressed in the PAUSE between leads. Nothing is executing then — the
//    run is a pending alarm and nothing else — so there is no loop to notice a
//    flag and wind the run down. If Stop only raises the flag, the run stays
//    "running" for ever and every later Start is refused.
{
  const leads = LEADS(6);
  const harness = makeChrome({
    leads, settings: { ...SETTINGS, perLeadDelayMin: 60000, perLeadDelayMax: 60000 }, onSend: sent,
  });
  globalThis.chrome = harness.chrome;
  // Long enough that Stop lands squarely inside a pause, not inside a send.
  harness.chrome.alarms.create = (name) => {
    const t = setTimeout(() => {
      if (!harness.chrome.alarms.__map.has(name)) return;
      harness.chrome.alarms.__map.delete(name);
      harness.listeners.alarm.forEach((fn) => fn({ name }));
    }, 400);
    harness.chrome.alarms.__map.set(name, { t });
  };
  await import(`../src/background.js?${Math.random()}`);
  const fire = (msg) => harness.listeners.message[0](msg, {}, () => {});
  fire({ type: "START" });
  // Wait until a pause is actually on: one lead sent and a step alarm pending.
  for (let i = 0; i < 200 && !(harness.state.sends >= 1 && harness.alarms.pending().length); i++) await sleep(20);
  check("the run reaches a pause between leads", harness.alarms.pending().length === 1,
    `sends=${harness.state.sends} alarms=${harness.alarms.pending().join(",")}`);

  fire({ type: "STOP" });
  const stopped = await settle(harness, 8000);
  check("Stop during the pause between leads ends the run", stopped,
    JSON.stringify({ running: harness.store.runState?.running, windows: harness.windows.open().length,
      alarms: harness.alarms.pending() }));
  check("  runState stops claiming a run", harness.store.runState?.running === false);
  check("  and a fresh Start is not refused",
    (fire({ type: "START" }), await sleep(400),
      !harness.log.some((m) => m.type === "LOG" && m.text === "a run is already in progress")),
    harness.log.filter((m) => m.type === "LOG").slice(-4).map((m) => m.text).join(" | "));

  // That Start left a run going, and every background module in this process
  // reads `chrome` off the global — so a run still moving here would write into
  // the NEXT scenario's storage. Shut it down before handing the global over.
  fire({ type: "STOP" });
  await settle(harness, 8000);
}

// 5. Follow-ups: after every DM, never before one, and paced 20% tighter.
{
  const HOUR = 3600000;
  const owed = [
    { id: "o1", handle: "old1", status: "sent", ts: Date.now() - 200 * HOUR, threadId: "t1", source: "manual" },
    { id: "o2", handle: "old2", status: "sent", ts: Date.now() - 100 * HOUR, threadId: "t2", source: "manual" },
  ];
  const order = [];
  const { harness, stopped } = await run({
    leadCount: 2,
    extraLeads: owed,
    followups: [{ id: "f1", text: "just floating this back up" }],
    settings: {
      ...SETTINGS, perLeadDelayMin: 10000, perLeadDelayMax: 10000,
      followupsEnabled: true, followupAfterHours: 48, followupMaxPerRun: 0,
    },
    onSend: (payload) => { order.push(payload.username); return sent(); },
  });
  check("a run with follow-ups stops on its own", stopped);
  check("  every DM goes before the first follow-up",
    order.join(",") === "lead0,lead1,old1,old2", order.join(","));
  check("  the oldest debt is paid first", order[2] === "old1", order.slice(2).join(","));
  check("  the run counts them separately",
    harness.store.runState?.sent === 2 && harness.store.runState?.followupsSent === 2,
    JSON.stringify({ sent: harness.store.runState?.sent, fu: harness.store.runState?.followupsSent }));
  const rec = harness.store[LEADS_KEY].find((l) => l.id === "o1");
  check("  the follow-up is recorded on the lead", (rec.followups || []).length === 1,
    JSON.stringify(rec.followups));
  check("  and its opener timestamp is untouched", rec.ts === owed[0].ts);
  check("  a follow-up never re-sends the opener path",
    harness.log.some((m) => m.type === "LOG" && /@old1 · follow-up 1$/.test(m.text || "")),
    harness.log.filter((m) => m.type === "LOG" && /@old/.test(m.text || "")).map((m) => m.text).join(" | "));
  const waits = harness.log.filter((m) => m.type === "LOG" && /^ {2}wait /.test(m.text || "")).map((m) => m.text.trim());
  check("  pauses between follow-ups are 20% shorter",
    waits.slice(0, 2).every((w) => w === "wait 10s") && waits.slice(2).every((w) => w === "wait 8s"),
    waits.join(" | "));
}

// 6. Follow-ups with nothing pending: the run still starts, and only follows up.
{
  const HOUR = 3600000;
  const { harness, stopped } = await run({
    leadCount: 0,
    extraLeads: [{ id: "o1", handle: "old1", status: "sent", ts: Date.now() - 200 * HOUR, threadId: "t1", source: "manual" }],
    followups: [{ id: "f1", text: "still here" }],
    settings: { ...SETTINGS, followupsEnabled: true, followupAfterHours: 48 },
    onSend: sent,
  });
  check("a run made only of follow-ups starts and finishes", stopped && harness.state.sends === 1,
    `${harness.state.sends} sends`);
  check("  and reports them as follow-ups, not sends",
    harness.store.runState?.followupsSent === 1 && harness.store.runState?.sent === 0,
    JSON.stringify({ sent: harness.store.runState?.sent, fu: harness.store.runState?.followupsSent }));
}

// 7. The notification, which is the only word you get when the window is behind
//    your work and you are not watching the log.
{
  const quiet = await run({ leadCount: 1, onSend: sent });
  check("nothing is notified while the switch is off", quiet.harness.state.notices.length === 0);

  const loud = await run({ leadCount: 1, settings: { ...SETTINGS, notifyOnFinish: true }, onSend: sent });
  check("a finished run notifies", loud.harness.state.notices.length === 1,
    JSON.stringify(loud.harness.state.notices));
  check("  and says what came of it", /^sent 1, failed 0$/.test(loud.harness.state.notices[0]?.message || ""),
    loud.harness.state.notices[0]?.message);

  const revoked = await run({
    leadCount: 1, settings: { ...SETTINGS, notifyOnFinish: true }, granted: false, onSend: sent,
  });
  check("a revoked permission is not assumed away", revoked.harness.state.notices.length === 0);

  // Giving up is the ending worth interrupting someone about.
  const dead = await run({
    leadCount: 5, settings: { ...SETTINGS, notifyOnFinish: true },
    onSend: () => ({ status: "failed", error: "the conversation didn't open" }),
  });
  check("a run that gives up notifies loudly", dead.harness.state.notices[0]?.priority === 2,
    JSON.stringify(dead.harness.state.notices[0]));
  check("  and names the reason", /kept failing/.test(dead.harness.state.notices[0]?.title || ""),
    dead.harness.state.notices[0]?.title);
}

// 8. The avatar is kept as bytes, because Instagram's link for it expires — and
//    the bytes come out of the page's own response, never a request of ours.
//    A request of our own carries a chrome-extension:// origin, which the CDN is
//    entitled to refuse, and it costs two more host permissions to make at all.
{
  const URL = "https://scontent.cdninstagram.com/a.jpg";
  const BYTES = "iVBORw0KGgo=";
  const { harness } = await run({ leadCount: 1, avatar: URL, avatarBytes: BYTES, onSend: sent });
  check("the avatar is stored as data, not as an expiring link",
    harness.store.profile?.avatarData === `data:image/jpeg;base64,${BYTES}`,
    String(harness.store.profile?.avatarData).slice(0, 60));
  check("  and it was the PAGE that asked for it", harness.state.pulled.join(",") === URL,
    harness.state.pulled.join(",") || "(nothing pulled)");
  check("  the picture is let through and the interception lifted",
    harness.state.fetch.join(",") === "enable,continuerequest,disable", harness.state.fetch.join(","));

  const failed = await run({ leadCount: 1, avatar: URL, onSend: sent });
  check("a picture the page can't load costs the avatar and nothing else",
    failed.stopped && !failed.harness.store.profile?.avatarData
      && failed.harness.store.profile?.username === "me",
    JSON.stringify(failed.harness.store.profile));
  check("  and says so in the log",
    failed.harness.log.some((m) => m.type === "LOG" && /couldn't keep the avatar/.test(m.text || "")),
    failed.harness.log.filter((m) => m.type === "LOG" && /avatar/.test(m.text || "")).map((m) => m.text).join(" | "));

  const noUrl = await run({ leadCount: 1, onSend: sent });
  check("no avatar URL at all is said out loud too, not swallowed",
    noUrl.harness.log.some((m) => m.type === "LOG" && /no avatar URL/.test(m.text || "")),
    noUrl.harness.log.filter((m) => m.type === "LOG" && /avatar/.test(m.text || "")).map((m) => m.text).join(" | "));
}

// 9. Two typing requests at once must not interleave. CDP has no idea who is
//    typing: run two typeText calls together and their keystrokes land in the
//    same field letter by letter, which is how a lead received one sentence
//    shredded into two — "yo, where are producers finding ayrot,iwshtesr ef oarr".
{
  const typed = [];
  const harness = makeChrome({
    leads: LEADS(1), settings: SETTINGS, followups: [],
    onSend: async () => {
      const fire = (text) => new Promise((resolve) =>
        harness.listeners.message[0]({ type: "INPUT", op: "type", text, speed: 4 },
          { tab: { id: harness.state.workTab } }, resolve));
      await Promise.all([fire("aaaa"), fire("bbbb")]);
      return sent();
    },
  });
  harness.chrome.debugger.sendCommand = async (_t, method, params) => {
    if (method === "Input.dispatchKeyEvent" && params && params.type === "keyDown" && params.text) {
      typed.push(params.text);
    }
    return {};
  };
  globalThis.chrome = harness.chrome;
  await import(`../src/background.js?${Math.random()}`);
  harness.listeners.message[0]({ type: "START" }, {}, () => {});
  await settle(harness, 25000);

  // human.js types the odd QWERTY neighbour and backspaces over it, so the raw
  // stream carries stray letters — the property under test is that one request
  // finishes before the other starts, not the exact keys.
  const joined = typed.join("");
  const order = joined.replace(/[^ab]/g, "");
  check("two typing requests do not interleave", /^a+b+$|^b+a+$/.test(order), joined || "(nothing typed)");
  check("  and every keystroke still arrives",
    (order.match(/a/g) || []).length >= 4 && (order.match(/b/g) || []).length >= 4, joined);
}

// 10. Direct's search doesn't find a lead. The run reaches everybody through
//     search on purpose, but that search misses accounts that plainly exist —
//     and writing the lead off for it was a skip nobody could tell from a dead
//     account. Now the worker opens the profile by address and asks again; what
//     the profile says is what decides the lead.
{
  const { harness } = await run({
    leadCount: 2,
    onSend: async (payload) => {
      if (!payload.settings.viaProfile) return { status: "notInSearch" };
      // lead0 is reachable from their profile; lead1 really is gone.
      return payload.username === "lead0"
        ? sent()
        : { status: "skipped", reason: "@lead1 doesn't exist any more" };
    },
  });
  check("a lead search can't find is opened by address",
    harness.state.navigations.includes("https://www.instagram.com/lead0/"),
    harness.state.navigations.join(" | ") || "(no navigation)");
  check("  and asked again by the other way in",
    harness.state.payloads.filter((p) => p.settings.viaProfile).length === 2,
    JSON.stringify(harness.state.payloads.map((p) => `${p.username}:${!!p.settings.viaProfile}`)));
  check("  a lead reachable from their profile is sent",
    harness.store[LEADS_KEY].find((l) => l.handle === "lead0")?.status === "sent",
    JSON.stringify(harness.store[LEADS_KEY].find((l) => l.handle === "lead0")));
  check("  and one whose profile is gone is skipped, with the reason",
    harness.store[LEADS_KEY].find((l) => l.handle === "lead1")?.status === "skipped"
    && /doesn't exist/.test(harness.store[LEADS_KEY].find((l) => l.handle === "lead1")?.error || ""),
    JSON.stringify(harness.store[LEADS_KEY].find((l) => l.handle === "lead1")));
  check("  the run still ends by itself", harness.store.runState?.running === false
    && harness.windows.open().length === 0);
  // The rendering override outlives a navigation on its own, but nothing in the
  // run should depend on knowing that — re-assert it after every one.
  check("  and the rendering override is re-asserted after the navigation",
    afterEach(harness.state.trace, (e) => e.startsWith("nav:"), "keeprendering"),
    harness.state.trace.join(" → "));
}

// 11. The cap is remembered. A run of 20 that only got 5 out leaves 15 owed, and
//     the next Start can either finish those 15 or begin a fresh 20 — which is
//     the whole difference between the two, so both are checked here. The queue
//     runs dry at 2 of 4 (a stopped run ends the same way, with fewer moving
//     parts), then more leads arrive and the run is started again.
{
  const startAgain = async (resume) => {
    const harness = makeChrome({
      leads: LEADS(2), settings: { ...SETTINGS, maxPerRun: 4 }, onSend: sent, followups: [],
    });
    globalThis.chrome = harness.chrome;
    await import(`../src/background.js?${Math.random()}`);
    const fire = (msg) => harness.listeners.message[0](msg, {}, () => {});
    fire({ type: "START" });
    await settle(harness);
    const first = harness.state.sends;

    harness.store[LEADS_KEY] = [...harness.store[LEADS_KEY], ...LEADS(4).map((l) => ({ ...l, id: `x${l.id}`, handle: `x${l.handle}` }))];
    fire({ type: "START", ...(resume ? { resume: true } : {}) });
    const restarted = await began(harness);
    await settle(harness);
    return { harness, first, restarted, second: harness.state.sends - first };
  };

  const kept = await startAgain(true);
  check("a run stopping under its cap sends what is left, not the cap again",
    kept.restarted && kept.first === 2 && kept.second === 2, `${kept.first} then ${kept.second}`);
  check("  and the tally it carried is the one the cap counted",
    kept.harness.store.runState?.sent === 4, JSON.stringify({ sent: kept.harness.store.runState?.sent }));
  check("  and the log says where it picked up",
    kept.harness.log.some((m) => m.type === "LOG" && /carrying on from 2 sent — 2 left of 4/.test(m.text || "")),
    kept.harness.log.filter((m) => m.type === "LOG").map((m) => m.text).slice(0, 12).join(" | "));

  const fresh = await startAgain(false);
  check("starting over spends the whole cap again",
    fresh.restarted && fresh.first === 2 && fresh.second === 4, `${fresh.first} then ${fresh.second}`);
  check("  from a tally of its own", fresh.harness.store.runState?.sent === 4,
    JSON.stringify({ sent: fresh.harness.store.runState?.sent }));
  check("  and says nothing about carrying on",
    !fresh.harness.log.some((m) => m.type === "LOG" && /carrying on/.test(m.text || "")));
}

// 11. Instagram reloads the page under a lead — its own doing, or our press on
//     its error screen. The content layer dies with the page, so this call's
//     answer is lost and the lead starts again; what must NOT happen is the
//     hands staying gone from a screen the user is watching, or the lead being
//     walked from scratch for ever.
{
  // Built by hand, not through run(): the stub has to reach back into the harness
  // it belongs to, which the helper only hands over once the run is over.
  let harness;
  const reloadPage = () => {
    harness.state.trace.push("reload");
    harness.listeners.message[0]({ type: "CONTENT_READY" }, { tab: { id: harness.state.workTab } }, () => {});
  };
  harness = makeChrome({
    leads: LEADS(1), settings: SETTINGS,
    onSend: async (_payload, n) => {
      if (n > 1) return sent();
      // The page comes back as a fresh content layer, and this call dies with it.
      reloadPage();
      throw new Error("Could not establish connection.");
    },
  });
  globalThis.chrome = harness.chrome;
  await import(`../src/background.js?${Math.random()}`);
  harness.listeners.message[0]({ type: "START" }, {}, () => {});
  await settle(harness);
  check("a reload mid-lead puts the hands back on the page",
    harness.state.hands.filter((on) => on === true).length >= 2,
    JSON.stringify(harness.state.hands));
  check("  and the lead is finished on the next try",
    harness.store[LEADS_KEY][0].status === "sent", JSON.stringify(harness.store[LEADS_KEY][0]));
}

// 12. …and a page that keeps reloading is given up on rather than walked to for
//     the rest of the retries — each of those is a whole lead's worth of
//     searching, opening and walking to a profile that will break again.
{
  let harness;
  const reloadPage = () => harness.listeners.message[0]({ type: "CONTENT_READY" },
    { tab: { id: harness.state.workTab } }, () => {});
  harness = makeChrome({
    leads: LEADS(1), settings: SETTINGS,
    onSend: async () => {
      reloadPage();
      throw new Error("Could not establish connection.");
    },
  });
  globalThis.chrome = harness.chrome;
  await import(`../src/background.js?${Math.random()}`);
  harness.listeners.message[0]({ type: "START" }, {}, () => {});
  await settle(harness);
  check("a page that keeps reloading gives up before the retries run out",
    harness.state.sends <= 4, `${harness.state.sends} sends`);
  check("  and the lead says why",
    /reloaded the page/.test(harness.store[LEADS_KEY][0].error || ""), JSON.stringify(harness.store[LEADS_KEY][0]));
  // Giving up is only half of it: the page is still working on that lead, and
  // the next one would be answered "busy sending to @…" until it is told to stop.
  check("  the page is told to stop working on it",
    harness.state.abandons >= 1, `${harness.state.abandons} abandons`);
}

// ── the audience filter ───────────────────────────────────────────────────────
// The filter itself lives in the content layer now: it reads the two numbers off
// the lead's PROFILE, because nothing the page fetches on its own carries them
// (measured — Direct's own account search has no counts in it) and asking the API
// for them is traffic ordinary browsing never makes. Two things stay the
// worker's: the flag it hands the page, and the verdict it answers with.
const FILTER = { ...SETTINGS, audienceFilter: true, minFollowers: 5000, maxFollowers: 0, minPosts: 0 };
const flagSent = (harness) => harness.state.payloads[0]?.settings.audienceFilter;

{
  const { harness } = await run({ leadCount: 1, onSend: sent });
  check("with the filter off the page is told not to bother", flagSent(harness) === false,
    String(flagSent(harness)));
}
{
  const { harness } = await run({
    leadCount: 1, onSend: sent,
    settings: { ...SETTINGS, audienceFilter: true, minFollowers: 0, maxFollowers: 0, minPosts: 0 },
  });
  check("a switch with no bound behind it is not a filter", flagSent(harness) === false,
    String(flagSent(harness)));
}
{
  const { harness } = await run({ leadCount: 1, settings: FILTER, onSend: sent });
  check("one bound turns it on for the page", flagSent(harness) === true, String(flagSent(harness)));
}
{
  const { harness } = await run({
    leadCount: 1, settings: { ...FILTER, followupsEnabled: true, followupAfterHours: 1 }, onSend: sent,
    followups: [{ id: "f1", text: "step one" }],
    extraLeads: [{ id: "old", handle: "answered", status: "sent", ts: Date.now() - 86400000, threadId: "t9" }],
  });
  const followup = harness.state.payloads.find((p) => p.message === "step one");
  check("a follow-up is never filtered", followup && followup.settings.audienceFilter === false,
    JSON.stringify(followup?.settings.audienceFilter));
}

// The verdict, asked the way the content layer asks it: mid-send, from the work
// tab, about the lead currently in flight.
{
  let harness;
  let refused = null;
  let turnedAway = null;
  let passed = null;
  let leadAfter = null;
  const ask = (sender, counts) => new Promise((resolve) =>
    harness.listeners.message[0]({ type: "AUDIENCE", ...counts }, sender, resolve));

  harness = makeChrome({
    leads: LEADS(1), settings: FILTER,
    onSend: async () => {
      const work = { tab: { id: harness.state.workTab } };
      refused = await ask({ tab: { id: 4242 } }, { followers: 9000, posts: 9 });
      turnedAway = await ask(work, { followers: 1200, posts: 9 });
      leadAfter = { ...harness.store[LEADS_KEY][0] };
      passed = await ask(work, { followers: 9000, posts: 9 });
      return sent();
    },
  });
  globalThis.chrome = harness.chrome;
  await import(`../src/background.js?${Math.random()}`);
  harness.listeners.message[0]({ type: "START" }, {}, () => {});
  await settle(harness);

  check("a lead under the bound does not pass", turnedAway && turnedAway.pass === false,
    JSON.stringify(turnedAway));
  check("  and the reason names the count and the bound",
    /1\.2k followers/.test(turnedAway?.reason || "") && /5k minimum/.test(turnedAway?.reason || ""),
    turnedAway?.reason);
  check("  the numbers are kept on the lead being worked",
    leadAfter?.followers === 1200 && leadAfter?.posts === 9, JSON.stringify(leadAfter));
  check("a lead inside the bound passes", passed && passed.pass === true, JSON.stringify(passed));
  check("  and what was seen is said out loud", /9k followers/.test(passed?.seen || ""), passed?.seen);
  // The content layer lives in the user's own Instagram tabs too, and this
  // answer decides a lead and writes to it.
  check("any tab but the work tab is refused", refused && !!refused.error && refused.pass === undefined,
    JSON.stringify(refused));
}

// The same check, asked of a worker Chrome threw away and started again. It
// comes back with none of its module state — including which tab the run is
// driving — and the walk from the thread to the profile is the quietest stretch
// of a lead, which is exactly when that happens. A worker that refuses its own
// work tab fails the lead over its own amnesia, so it reads the tab back out of
// storage (recallWork) before turning anybody away.
{
  const harness = makeChrome({ leads: LEADS(1), settings: FILTER, onSend: async () => sent() });
  globalThis.chrome = harness.chrome;
  // The window the last worker opened is still there, and it left the tab in
  // storage on purpose — this is that worker's successor, not its first run.
  const win = await harness.chrome.windows.create({ url: "https://www.instagram.com/direct/inbox/" });
  harness.store.work = { windowId: win.id, tabId: win.tabs[0].id };
  await import(`../src/background.js?${Math.random()}`);
  const reborn = harness.listeners.message[harness.listeners.message.length - 1];
  const ask = (sender) => new Promise((resolve) =>
    reborn({ type: "AUDIENCE", followers: 9000, posts: 9 }, sender, resolve));

  const mine = await ask({ tab: { id: win.tabs[0].id } });
  check("a worker that came back answers its own work tab", mine && mine.pass === true, JSON.stringify(mine));
  const stranger = await ask({ tab: { id: 4242 } });
  check("  and still refuses every other tab", stranger && !!stranger.error && stranger.pass === undefined,
    JSON.stringify(stranger));

  // Every other guard has the same amnesia to survive. Input is the one that
  // matters most: refused, the lead can't click or type at all. What it does
  // after the guard is not this test's business — a fresh worker holds no
  // debugger — only that it is no longer turned away as a stranger.
  const send = (type, extra = {}, tabId = win.tabs[0].id) => new Promise((resolve) =>
    reborn({ type, ...extra }, { tab: { id: tabId } }, resolve));
  const input = await send("INPUT", { op: "key", key: "Enter" });
  check("  input from that tab is no longer refused as a stranger",
    !/only allowed from the work tab/.test(input?.error || ""), JSON.stringify(input));
  const strangerInput = await send("INPUT", { op: "key", key: "Enter" }, 4242);
  check("  input from any other tab still is",
    /only allowed from the work tab/.test(strangerInput?.error || ""), JSON.stringify(strangerInput));

  // The hands live in the page, so a reload takes them off screen; the worker
  // puts them back when the content layer says hello. A worker that came back
  // to a page that came back has to recognise the tab for that to happen.
  harness.state.hands.length = 0;
  // Nothing answers this one, so it is told rather than asked.
  reborn({ type: "CONTENT_READY", url: "https://www.instagram.com/direct/inbox/" },
    { tab: { id: win.tabs[0].id } }, () => {});
  for (let i = 0; i < 40 && !harness.state.hands.length; i++) await sleep(25);
  check("  and the hands go back on a page that reloaded under it",
    harness.state.hands.includes(true), JSON.stringify(harness.state.hands));
}

// A number the page would not give up is never a pass — the filter would go on
// claiming in Settings to be doing something.
{
  let harness;
  let unreadable = null;
  harness = makeChrome({
    leads: LEADS(1), settings: FILTER,
    onSend: async () => {
      unreadable = await new Promise((resolve) => harness.listeners.message[0](
        { type: "AUDIENCE", followers: undefined, posts: 9 },
        { tab: { id: harness.state.workTab } }, resolve));
      return sent();
    },
  });
  globalThis.chrome = harness.chrome;
  await import(`../src/background.js?${Math.random()}`);
  harness.listeners.message[0]({ type: "START" }, {}, () => {});
  await settle(harness);
  check("an unreadable count is an error, not a pass",
    unreadable && !!unreadable.error && unreadable.pass === undefined, JSON.stringify(unreadable));
}

// ── the platform's say ────────────────────────────────────────────────────────
// Not connected: nothing opens, nothing is sent, and the log says what to do.
{
  const { harness } = await run({ leadCount: 2, onSend: sent, connected: false });
  check("without an Artist Outreach account the run doesn't start", harness.state.sends === 0 && !harness.store.runState?.running,
    `${harness.state.sends} sends`);
  check("  no window was opened", harness.state.windowsClosed === 0 && harness.windows.open().length === 0);
  check("  and the log says how to connect",
    harness.log.some((m) => m.type === "LOG" && /Connect your Artist Outreach account/.test(m.text)));
  check("  the run is not left claiming to be running", !harness.store.runState?.running, JSON.stringify(harness.store.runState ?? null));
}

// Plan not active: same refusal, different words.
{
  const { harness } = await run({ leadCount: 2, onSend: sent, platform: { access: false } });
  check("an inactive plan doesn't start a run", harness.state.sends === 0);
  check("  and says so", harness.log.some((m) => m.type === "LOG" && /plan isn't active/.test(m.text)));
}

// Starter: 3 left today, 5 in the queue → 3 go out, the run stops, 2 stay pending.
{
  const { harness, stopped } = await run({ leadCount: 5, onSend: sent, platform: { limit: 10, used: 7 } });
  const leads = harness.store[LEADS_KEY];
  check("the daily limit stops the run", stopped && harness.state.sends === 3, `${harness.state.sends} sends`);
  check("  the rest stay pending for tomorrow", leads.filter((l) => l.status === "pending").length === 2,
    leads.map((l) => l.status).join(","));
  check("  the usage reached exactly the limit", PLATFORM.used === 10, `${PLATFORM.used}`);
  check("  and the log says why", harness.log.some((m) => m.type === "LOG" && /today's 10 automated DMs/.test(m.text)));
  check("  the work window is closed", harness.windows.open().length === 0);
}

// Starter with nothing left: refused before the window opens.
{
  const { harness } = await run({ leadCount: 2, onSend: sent, platform: { limit: 10, used: 10 } });
  check("a used-up allowance refuses the run up front", harness.state.sends === 0 && harness.windows.open().length === 0);
}

// A send that doesn't happen gives its unit back.
{
  const { harness } = await run({ leadCount: 3, onSend: (_p, n) => (n === 2 ? { status: "skipped", reason: "private account" } : sent()), platform: { limit: 10, used: 0 } });
  check("a skipped lead gives its DM back", PLATFORM.used === 2 && PLATFORM.releases === 1,
    `used ${PLATFORM.used}, releases ${PLATFORM.releases}, sends ${harness.state.sends}`);
}

// Pro: unlimited, but every send is still claimed (counted).
{
  const { harness } = await run({ leadCount: 4, onSend: sent, platform: { limit: null } });
  check("Pro sends everything and every send is counted", harness.state.sends === 4 && PLATFORM.claims === 4,
    `${harness.state.sends} sends, ${PLATFORM.claims} claims`);
}

console.log(results.join("\n"));
const ok = results.every((r) => r.startsWith("PASS"));
console.log(ok ? "ALL PASS" : "SOME FAILED");
process.exit(ok ? 0 : 1);
