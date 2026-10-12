// shots-seed.js — the demo state the store screenshots are taken against.
//
// Loaded as a classic script BEFORE src/app.js, so the chrome stub and the
// seeded storage are in place by the time the app's init() reads them. The app
// itself is untouched: every number on screen is computed by src/stats.js and
// src/followups.js from the leads and inbox facts below, so a screenshot cannot
// show a total that the real code would not produce.
//
// Handles and names are invented — a store listing must not publish real
// people's accounts. The opener texts and their reply counts are the ones from
// the campaign the screenshots are modelled on.
//
// Deterministic: one seeded PRNG, no Date-dependent randomness, so re-running
// produces byte-identical layout apart from the clock.

(() => {
  const DAY = 86400000;
  const HOUR = 3600000;
  const now = Date.now();

  const mulberry32 = (a) => () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rnd = mulberry32(20260728);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const shuffle = (arr) => {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };

  // ── the table ───────────────────────────────────────────────────────────────
  // The stage name comes first and the handle is derived from it, the way a real
  // table reads — deriving the name from the handle instead produced artists
  // called "Mcvellumofficial".
  const TITLE = ["Lil", "Yung", "DJ", "King", "Big", "Young", "Saint", "Baby", "MC", "", "", ""];
  const NAME = ["Nova", "Marrow", "Kayde", "Vellum", "Onyx", "Serif", "Halo", "Mirage",
    "Cobalt", "Juno", "Rowe", "Sable", "Zephyr", "Quill", "Axiom", "Drift", "Ember",
    "Fable", "Glint", "Harlow", "Ivory", "Jaded", "Kismet", "Lumen", "Nectar", "Obsidian",
    "Plume", "Quarry", "Rune", "Solace", "Tundra", "Umbra", "Verve", "Wisp", "Yarrow",
    "Zenith", "Callow", "Dune", "Fenwick", "Grove"];
  const SUFFIX = ["", "", "", "_", ".hq", "music", "beats", "wrld", "xo", "01", "official"];
  const TRACKS = ["Nightshift", "Paper Cuts", "Blue Hour", "Static Bloom", "Low Tide",
    "Cold Open", "Marble Sky", "Runback", "Half Light", "Velvet Noise", "Ash & Gold",
    "Second Wind", "Slow Burner", "Neon Fast", "Ghost Note", "Overpass", "Dust Radio",
    "Winter Palm", "Glass House", "Tunnel Vision"];
  const CITIES = ["Atlanta", "London", "Toronto", "Berlin", "Chicago", "Manchester",
    "Houston", "Amsterdam", "Detroit", "Paris", "Brooklyn", "Lisbon", "Dublin", "Oslo"];

  const TOTAL = 239;                    // rows in the table
  const handles = [];
  const artists = [];
  const seenHandle = new Set();
  while (handles.length < TOTAL) {
    const title = pick(TITLE);
    const artist = (title ? `${title} ` : "") + pick(NAME);
    const handle = artist.toLowerCase().replace(/\s+/g, "") + pick(SUFFIX);
    if (seenHandle.has(handle)) continue;
    seenHandle.add(handle);
    handles.push(handle);
    artists.push(artist);
  }

  const followerText = () => {
    const n = int(900, 84000);
    return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
  };

  const headers = ["instagram", "artist", "top_track", "city", "followers"];
  const rows = handles.map((h, i) => [h, artists[i], pick(TRACKS), pick(CITIES), followerText()]);

  const table = {
    headers,
    rows,
    matchColumn: null,                  // auto-detected: "instagram" is column 0
    fileName: "artists-outreach.csv",
    importedAt: now - 39 * DAY,
  };

  // ── the message variants ────────────────────────────────────────────────────
  const messages = [
    { id: "m_a", text: "yoo {artist} i wanted to tap in with you, i got beats ready what's ur digits?" },
    { id: "m_b", text: "yo {artist} shoot me your digits for beats" },
    { id: "m_c", text: "yo {artist}, {top_track} is crazy send your digits for beats" },
    { id: "m_d", text: "yo {artist} i'm music producer, also own marketing agency what's your digits let's lock in, i got something for you" },
  ];

  const followups = [
    { id: "f_1", text: "hey {artist}, floating this back up — still got those beats ready 👋" },
    { id: "f_2", text: "last one from me, {artist} — want me to send a couple over?" },
  ];

  // Sends and replies per opener. Everything downstream is derived from these,
  // so the dashboard's totals are these numbers added up by the real code.
  const PLAN = [
    { id: "m_a", sent: 63, replied: 5 },
    { id: "m_b", sent: 53, replied: 6 },
    { id: "m_c", sent: 51, replied: 4 },
    { id: "m_d", sent: 46, replied: 2 },
  ];
  const SENT_COUNT = PLAN.reduce((n, p) => n + p.sent, 0);        // 213

  // Reply lags, ordered so the median (the 9th of 17) is the 3h the campaign ran at.
  const LAG_MIN = [12, 34, 55, 78, 96, 130, 165, 172, 187, 205, 240, 300, 420, 600, 900, 1400, 4000];

  const slots = shuffle(PLAN.flatMap((p) =>
    Array.from({ length: p.sent }, (_, i) => ({ messageId: p.id, replied: i < p.replied }))));

  const formats = shuffle([
    ...Array(121).fill("justDM"),
    ...Array(54).fill("replyToPost"),
    ...Array(38).fill("replyToStory"),
  ]);

  // ── when the sends happened ─────────────────────────────────────────────────
  // 38 days of history so the activity grid has shape; nothing on most Sundays,
  // and the hours weighted the way a person actually works.
  const HOUR_WEIGHTS = [0, 0, 0, 0, 0, 0, 0, 1, 2, 4, 7, 8, 7, 6, 9, 9, 8, 7, 6, 4, 3, 2, 1, 0];
  const hourPool = HOUR_WEIGHTS.flatMap((w, h) => Array(w).fill(h));

  const stamps = [];
  for (let d = 38; d >= 0 && stamps.length < SENT_COUNT; d--) {
    const dayStart = new Date(now - d * DAY);
    dayStart.setHours(0, 0, 0, 0);
    const weekday = dayStart.getDay();
    const quota = weekday === 0 ? int(0, 2) : int(2, 11);
    for (let i = 0; i < quota && stamps.length < SENT_COUNT; i++) {
      stamps.push(dayStart.getTime() + pick(hourPool) * HOUR + int(0, 59) * 60000 + int(0, 59) * 1000);
    }
  }
  while (stamps.length < SENT_COUNT) {              // top up the last few days
    const d = int(0, 6);
    const day = new Date(now - d * DAY);
    day.setHours(0, 0, 0, 0);
    stamps.push(day.getTime() + pick(hourPool) * HOUR + int(0, 59) * 60000);
  }
  stamps.sort((a, b) => a - b);                     // the queue is worked top-down

  // ── the leads ───────────────────────────────────────────────────────────────
  // Statuses sit where the table put them: a lead that failed keeps its row, so
  // sent / skipped / failed interleave and the pending tail is what is left.
  const SKIP_REASONS = ["profile not found", "private account", "DMs closed",
    "already in a conversation", "skipped by hand"];
  const FAIL_REASONS = ["no result matched @handle in Direct search",
    "DM composer not found"];

  const REMOVED_AT = new Set([37, 118, 204]);
  const SKIP_AT = new Set([26, 71, 109, 158, 199]);
  const FAIL_AT = new Set([63, 181]);

  const leads = [];
  const inbox = {};
  let sentIdx = 0;
  let lagIdx = 0;
  let stoppedLeft = 6;

  handles.forEach((handle, i) => {
    const base = { id: `l_${i}`, handle, source: "table" };

    if (REMOVED_AT.has(i)) { leads.push({ ...base, status: "pending", removed: true }); return; }
    if (SKIP_AT.has(i)) {
      leads.push({ ...base, status: "skipped", error: pick(SKIP_REASONS), ts: stamps[Math.min(sentIdx, SENT_COUNT - 1)] });
      return;
    }
    if (FAIL_AT.has(i)) {
      leads.push({ ...base, status: "failed", error: pick(FAIL_REASONS), ts: stamps[Math.min(sentIdx, SENT_COUNT - 1)] });
      return;
    }
    if (sentIdx >= SENT_COUNT) { leads.push({ ...base, status: "pending" }); return; }

    const slot = slots[sentIdx];
    const ts = stamps[sentIdx];
    const threadId = `34028${String(100000 + sentIdx)}`;
    sentIdx++;

    const lead = {
      ...base,
      status: "sent",
      ts,
      threadId,
      sentMessageId: slot.messageId,
      format: formats[sentIdx - 1],
    };

    // Follow-ups went out as the campaign aged: two steps on anyone written to
    // more than six days ago, one on the six-to-three-day band, none yet on the
    // rest. A handful could not be reached a second time and are stopped.
    const age = now - ts;
    const done = [];
    if (!slot.replied) {
      if (age > 6 * DAY) {
        done.push({ ts: ts + 2 * DAY, stepId: "f_1" }, { ts: ts + 4.5 * DAY, stepId: "f_2" });
      } else if (age > 3 * DAY) {
        done.push({ ts: ts + 2 * DAY, stepId: "f_1" });
      }
      if (done.length === 1 && stoppedLeft > 0 && rnd() < 0.12) {
        stoppedLeft--;
        lead.followupsOff = true;
        lead.followupError = "profile not found in Direct search";
      }
    }
    if (done.length) lead.followups = done;

    const firstReplyMs = slot.replied ? ts + LAG_MIN[lagIdx++ % LAG_MIN.length] * 60000 : 0;
    inbox[threadId] = {
      threadId,
      username: handle,
      lastActivityMs: Math.max(firstReplyMs, done.length ? done[done.length - 1].ts : ts),
      firstOutMs: ts,
      firstReplyMs,
      replied: slot.replied,
      outCount: 1 + done.length,
      inCount: slot.replied ? int(1, 4) : 0,
    };

    leads.push(lead);
  });

  // Conversations that were already in the inbox before any of this — read by
  // the same capture pass, counted by "conversations read" and nothing else.
  for (let i = 0; i < 24; i++) {
    const id = `34028${String(900000 + i)}`;
    const t = now - int(2, 300) * DAY;
    inbox[id] = {
      threadId: id, username: `${pick(NAME).toLowerCase()}${pick(SUFFIX)}`, lastActivityMs: t,
      firstOutMs: 0, firstReplyMs: 0, replied: false, outCount: 0, inCount: int(1, 9),
    };
  }

  const settings = {
    formatJustDM: true,
    formatReplyToPost: true,
    formatReplyToStory: true,
    maxPerRun: 40,
    skipExisting: true,
    perLeadDelayMin: 45000,
    perLeadDelayMax: 120000,
    typingSpeed: 1.1,
    followupsEnabled: true,
    followupAfterHours: 48,
    followupMaxPerRun: 0,
    notifyOnFinish: true,
  };

  const profile = {
    username: "kayde.prod",
    fullName: "Kayde",
    bio: "producer · beats for artists · dm for the drive",
    followers: 4218,
    posts: 96,
    avatar: null,                       // no network in a screenshot run: initials instead
  };

  const runState = {
    running: false, currentIndex: 39, consecutiveFailures: 0,
    total: 40, sent: 38, failed: 1, followupTotal: 14, followupsSent: 12,
    startedAt: now - 4 * HOUR, stopRequested: false, phase: null,
  };

  const store = {
    table, messages, followups, leads, settings, runState, profile,
    inbox, inboxScannedAt: now - 4 * HOUR, humanSeed: "shots",
  };

  // The live log, in the worker's own wording (see src/background.js) — the tail
  // of the run whose totals runState above reports.
  const tail = leads.filter((l) => l.status === "sent").slice(-4);
  const log = [
    { text: `(37/40) @${tail[0].handle} · ${tail[0].format}` },
    { text: "  → sent" },
    { text: "  wait 78s" },
    { text: `(38/40) @${tail[1].handle} · follow-up 2` },
    { text: "  → follow-up 2 sent" },
    { text: "  wait 54s" },
    { text: `(39/40) @${tail[2].handle} · ${tail[2].format}` },
    { text: "  → skipped (DMs closed)" },
    { text: "  wait 96s" },
    { text: `(40/40) @${tail[3].handle} · ${tail[3].format}` },
    { text: "  → sent" },
    { text: "done — sent 38, failed 1, 12 follow-ups" },
    { text: "closing the work window in a few seconds…" },
  ];

  // ── the chrome stub ─────────────────────────────────────────────────────────
  const listeners = [];
  window.chrome = {
    storage: {
      local: {
        get: (key) => Promise.resolve(key in store ? { [key]: store[key] } : {}),
        set: (obj) => { Object.assign(store, obj); return Promise.resolve(); },
      },
    },
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: () => Promise.resolve(),
      getURL: (p) => p,
    },
    permissions: {
      request: () => Promise.resolve(false),
      remove: () => Promise.resolve(true),
    },
  };

  // Everything the run bar shows arrives as a worker message, so the demo sends
  // real ones rather than writing into the DOM behind the app's back.
  window.__fire = (msg) => listeners.forEach((fn) => fn(msg));
  window.__demo = { runState, log };
})();
