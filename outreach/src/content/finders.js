// finders.js — the finders and probes that more than one surface needs.
//
// IG has no stable class names, so every finder keys on text / aria-label /
// geometry, with RU+EN+major-EU vocabulary (ported from Tabels' engine). When a
// step starts failing, this is where the matching strings get retuned.

(() => {
  "use strict";
  const S = globalThis.__igs;
  const { norm, handle, isVisible, waitFor } = S;

  // Localized search-field vocabulary (matches Tabels' searchInputRe).
  const SEARCH_RE = /such|search|поиск|искать|buscar|busca|recherch|cerca|ricerc|pesquis|szukaj|wyszuk/i;
  const isSearchField = (el) => {
    const ph = (el.getAttribute("placeholder") || "").toLowerCase();
    const al = (el.getAttribute("aria-label") || "").toLowerCase();
    return SEARCH_RE.test(ph) || SEARCH_RE.test(al) || el.type === "search";
  };

  // The DM composer: the lowest non-search editable field.
  function findComposer() {
    const cands = [...document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"], input:not([type])')]
      .filter((el) => !isSearchField(el))
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 60 && r.height > 10; });
    cands.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    return cands[0] || null;
  }

  function threadIsOpen() {
    const p = location.pathname;
    if (!/\/direct\//.test(p) || /\/direct\/inbox\/?$/.test(p)) return false;
    return !!findComposer();
  }

  const SEND_RE = /^(senden|send|enviar|отправить|inviare|invia|publicar|envoyer)$/i;
  function findSendButton() {
    return [...document.querySelectorAll('[role="button"], button, div[role="button"], a[role="button"]')]
      .find((b) => {
        const t = norm(b.textContent);
        const al = norm(b.getAttribute("aria-label"));
        const r = b.getBoundingClientRect();
        return (SEND_RE.test(t) || SEND_RE.test(al)) && r.width > 1 && r.height > 1;
      }) || null;
  }

  // Every leaf text in a row, normalized — one of them is the @handle. Both the
  // share sheet and Direct's search build rows this way.
  const rowHandles = (row) =>
    [...row.querySelectorAll("span, p, small, div, a, h1, h2")]
      .filter((c) => c.children.length === 0)
      .map((c) => handle(c.textContent));

  // The Message button on a profile — the only way into a conversation when
  // Direct's own search cannot find the account.
  //
  // NOT the navigation, which is one letter away: the desktop left rail carries
  // a "Messages" link and a profile's own button says "Message". Matching the
  // plural clicked the rail instead, which walks out of the profile into the
  // inbox — the lead's thread is not open there, so every attempt reported
  // "their Message button didn't open a conversation" and then found itself in
  // Direct. Anything inside a link to /direct/ is the rail, whatever it says,
  // and the profile's button lives in the page's header.
  const MESSAGE_RE = /^(message|nachricht senden|mensaje|enviar mensaje|написать|написать сообщение|сообщение|отправить сообщение|messaggio|messaggio diretto|envoyer un message)$/i;
  const isMessageEntry = (b) =>
    !b.closest('a[href*="/direct/"], nav, [role="navigation"]') &&
    (MESSAGE_RE.test(norm(b.textContent)) || MESSAGE_RE.test(norm(b.getAttribute("aria-label"))));

  function findMessageButton() {
    const buttons = [...document.querySelectorAll('header [role="button"], header button, header a, [role="button"], button, div[tabindex]')]
      .filter(isVisible)
      .filter(isMessageEntry);
    return buttons.find((b) => b.closest("header")) || buttons[0] || null;
  }

  // Instagram's inline chat. The Message button on a profile no longer navigates
  // to /direct/t/… — it opens a small chat panel ON TOP of the profile, with the
  // lead's name and handle in its header and a "Message…" box at the bottom, and
  // the address bar never changes. So "their conversation is open" could not go
  // on meaning "the URL says so": every entry through a profile reported "their
  // Message button didn't open a conversation" with the chat sitting right there.
  //
  // Two things have to hold together, because a post page also has a text box
  // under the author's name and typing the message THERE would publish it as a
  // public comment: the box has to ask for a message (a comment box asks for a
  // comment), and the panel around it has to name this lead.
  const CHAT_FIELD_RE = /message|nachricht|mensaje|сообщени|messaggio|antworten|répondre/i;
  const COMMENT_FIELD_RE = /comment|kommentar|коммент|comentario|commento|commentaire/i;

  const isChatField = (el) => {
    const hint = `${el.getAttribute("placeholder") || ""} ${el.getAttribute("aria-label") || ""}`;
    return CHAT_FIELD_RE.test(hint) && !COMMENT_FIELD_RE.test(hint);
  };

  function findLeadChatBox(username) {
    const uLow = handle(username);
    if (!uLow) return null;
    const escaped = uLow.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const names = new RegExp(`(^|[^a-z0-9._])${escaped}([^a-z0-9._]|$)`, "i");
    const fields = [...document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"], input:not([type])')]
      .filter(isVisible).filter((el) => !isSearchField(el)).filter(isChatField);
    for (const field of fields) {
      let node = field.parentElement;
      for (let i = 0; i < 8 && node && node !== document.body; i++, node = node.parentElement) {
        if (names.test(norm(node.innerText))) return field;
      }
    }
    return null;
  }

  // ── probes ────────────────────────────────────────────────────────────────────
  // Can we message this lead at all? (not-found / private-locked / no Message btn)
  function probeReachability() {
    const bodyText = ((document.body && document.body.innerText) || "").toLowerCase();
    if (/sorry, this page isn'?t available|page not found|leider ist diese seite nicht verfügbar|nichts gefunden|страница недоступна/.test(bodyText))
      return "notFound";

    const hasMsgBtn = !!findMessageButton();

    if (/this account is private|dieses konto ist privat|аккаунт закрыт|закрытый аккаунт/.test(bodyText)) {
      const followingRe = /^(following|gefolgt|abonniert|seguindo|sigues|подписки|вы подписаны)$/i;
      const following = [...document.querySelectorAll("header [role=\"button\"], header button")]
        .some((b) => followingRe.test(norm(b.textContent)));
      if (!following && !hasMsgBtn) return "privateLocked";
    }
    return hasMsgBtn ? "reachable" : "noMessageEntry";
  }

  // Bubble scan: does the OPEN THREAD already hold a conversation?
  //
  // A message bubble is pinned to one edge of the thread — theirs left, ours
  // right — while a centred block (the intro card, a timestamp, "Seen") hugs
  // neither. That is the whole classifier, and it is why an empty thread reads
  // as empty.
  //
  // The edges that matter are the THREAD's, not the viewport's. Instagram's
  // Direct is two columns at desktop width and the left one lists every
  // conversation you have; measuring against the viewport counted each of those
  // rows as a message from the lead, so every lead came back "existing
  // conversation" and got skipped. The band comes from the composer — the one
  // element that is unambiguously in the thread column — and anything centred
  // outside it belongs to somebody else's conversation.
  // Direct's thread header runs about 74px; the scan starts below it. Cutting
  // the top costs nothing because the thread is scrolled to its newest message
  // first — what we need to see is at the bottom.
  const HEADER_BAND = 90;
  const HUG = 0.12;          // a bubble touches one edge of the column: within this much of it
  const TILT = 0.04;         // …and sits this much nearer that edge than the other

  const TRANSPARENT = /^rgba\(0, 0, 0, 0\)$|^transparent$/;

  // What the page itself is painted in. A block filled with THAT colour is a
  // card standing on the background, not a bubble — and Instagram's own white is
  // what made the Notes strip look like messages.
  function pageFill() {
    for (const el of [document.body, document.documentElement]) {
      const bg = el && getComputedStyle(el).backgroundColor;
      if (bg && !TRANSPARENT.test(bg)) return bg;
    }
    return "rgb(255, 255, 255)";
  }

  // The pill a message is drawn in. Text alone cannot be told apart from an
  // intro card or a header by position — the bubble's FILL is what makes it a
  // message. Walks up from the text because the fill lives on an ancestor of it,
  // and keeps walking past anything too wide to be a bubble (a row wrapper, the
  // page background). An emoji-only message has no pill and so isn't found here:
  // that costs a duplicate message at worst, where a false positive costs the
  // lead entirely.
  function bubbleRect(el, bandWidth, page) {
    let node = el;
    for (let i = 0; i < 5 && node && node !== document.body; i++, node = node.parentElement) {
      const bg = getComputedStyle(node).backgroundColor;
      if (!bg || TRANSPARENT.test(bg) || bg === page) continue;
      const r = node.getBoundingClientRect();
      if (r.width > 24 && r.width < bandWidth * 0.85) return r;
    }
    return null;
  }

  // The card an empty thread shows — avatar, display name, "<handle> · Instagram",
  // View profile — is not a conversation. Its pieces sit in filled pills (the
  // button is one) and can land against an edge of the column, which from
  // geometry alone is exactly what a message looks like: observed in=1 pills=1
  // seen=2 on a thread with nothing in it, and the lead skipped as already
  // written to. So the card is found by its View profile button and everything
  // inside it is left out of the scan — NOT treated as proof of emptiness, since
  // Instagram shows the same card above the history of a thread that has one.
  const VIEW_PROFILE_RE = /^(view profile|посмотреть профиль|profil ansehen|ver perfil|ver o perfil|voir le profil|vedi profilo)$/i;

  function introCardBox(bandWidth) {
    const btn = [...document.querySelectorAll('[role="button"], button, a')]
      .filter(isVisible)
      .find((b) => VIEW_PROFILE_RE.test(norm(b.textContent)));
    if (!btn) return null;
    let card = btn;
    for (let i = 0; i < 6 && card.parentElement; i++) {
      if (card.parentElement.getBoundingClientRect().width > bandWidth * 0.95) break;
      card = card.parentElement;
    }
    return card;
  }

  function scanThread(bandLeft, bandRight, floor) {
    const width = bandRight - bandLeft;
    const page = pageFill();
    const card = introCardBox(width);
    const seen = new Set();
    const out = { incoming: 0, outgoing: 0, considered: 0, filled: 0, hidden: 0, card: 0, first: "" };
    for (const el of document.querySelectorAll("div, span, p")) {
      const txt = norm(el.textContent);
      if (!txt) continue;
      // Keep the tightest element holding this text: a parent that says exactly
      // what its child says is a layout wrapper, not the bubble.
      let childSame = false;
      for (const c of el.children) if (norm(c.textContent) === txt) { childSame = true; break; }
      if (childSame) continue;
      if (card && card.contains(el)) { out.card++; continue; }
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.width > width * 0.92) continue;
      if (r.height < 14 || r.height > 600) continue;
      if (r.top < HEADER_BAND || r.bottom > floor) continue;
      const centre = (r.left + r.right) / 2;
      if (centre < bandLeft || centre > bandRight) continue;
      const key = Math.round(r.top) + ":" + Math.round(r.left) + ":" + txt.length;
      if (seen.has(key)) continue;
      seen.add(key);

      // Being AT a coordinate is not being PAINTED there. Instagram's Notes
      // strip scrolls sideways inside the conversation list, and its off-screen
      // items keep reporting rects that land squarely inside the thread's
      // column — five of them, each in a white pill, read as messages from the
      // lead. Only a hit test knows the difference, and it is the same one every
      // click in this extension already goes through.
      const aim = { x: centre, y: (r.top + r.bottom) / 2 };
      if (!S.inViewport(aim) || !S.aimIsClear(el, aim)) { out.hidden++; continue; }
      out.considered++;

      const bubble = bubbleRect(el, width, page);
      if (!bubble) continue;
      out.filled++;
      // Both tests are relative to the column, never a fixed number of pixels: at
      // desktop width a centred intro card sits ~45% from each edge, and a few px
      // of asymmetry was enough to make it look "closer to the left" — which is
      // how an empty thread got read as sixteen incoming messages.
      //
      // Touching an edge is what makes it a bubble; a centred card touches
      // neither. The tilt then says whose it is, and stays small because a long
      // message runs nearly the full width of the column and still belongs to
      // whichever side it started on. A block touching BOTH edges is a banner
      // across the thread, not a message, and tilts to nobody.
      const leftGap = bubble.left - bandLeft;
      const rightGap = bandRight - bubble.right;
      if (Math.min(leftGap, rightGap) > width * HUG) continue;
      // The text of the first block counted, because "in=1" on a thread with
      // nothing in it says nothing about WHAT was counted.
      if (!out.first) out.first = txt.slice(0, 30);
      if (leftGap + width * TILT < rightGap) out.incoming++;
      else if (rightGap + width * TILT < leftGap) out.outgoing++;
    }
    return out;
  }

  // Only the thread's own scrollport, never the conversation list beside it:
  // scrolling that one would make Instagram fetch more threads and move the
  // rows out from under the cursor.
  function scrollThreadToLatest(bandLeft, bandRight) {
    for (const el of document.querySelectorAll("div")) {
      if (el.scrollHeight <= el.clientHeight + 40) continue;
      const r = el.getBoundingClientRect();
      const centre = (r.left + r.right) / 2;
      if (centre < bandLeft || centre > bandRight) continue;
      if (!/auto|scroll|overlay/.test(getComputedStyle(el).overflowY)) continue;
      el.scrollTop = el.scrollHeight;
    }
  }

  // `confident` is what makes an empty verdict trustworthy: a thread that
  // rendered its intro card and nothing else really is empty, but a pane that
  // rendered nothing at all is a page we failed to read — and skipping a lead
  // on that is how a real lead gets dropped for good. The card itself counts as
  // having read the thread, since on an empty one it is the only thing there.
  async function probeExistingMessages(timeout = 4000) {
    const composer = findComposer();
    if (!composer) return { any: false, incoming: false, confident: false, debug: "no composer" };
    const box = composer.getBoundingClientRect();
    // The composer is inset from the column's edges and bubbles can sit a little
    // outside it, so the band is widened rather than taken literally.
    const bandLeft = box.left - 48;
    const bandRight = box.right + 48;

    scrollThreadToLatest(bandLeft, bandRight);
    await S.sleep(500);

    // A thread paints its bubbles after the list settles, so a single look can
    // land on an empty frame of a conversation that is not empty at all.
    let last = { incoming: 0, outgoing: 0, considered: 0, filled: 0, hidden: 0, card: 0, first: "" };
    const end = Date.now() + timeout;
    do {
      last = scanThread(bandLeft, bandRight, box.top - 4);
      if (last.incoming || last.outgoing) break;
      await S.sleep(300);
    } while (Date.now() < end);

    return {
      any: last.incoming + last.outgoing > 0,
      incoming: last.incoming > 0,
      // The card counts as having READ the thread: it is Instagram's own proof
      // that the conversation rendered and holds nothing. Without it an empty
      // thread — where the card is all there is — would report "not readable".
      confident: last.considered > 0 || last.card > 0,
      // The band goes in the line too: every misread of this probe so far has
      // been a band that didn't match the column it was measuring.
      debug: `in=${last.incoming} out=${last.outgoing} pills=${last.filled}`
        + ` seen=${last.considered} hidden=${last.hidden} card=${last.card}`
        + ` band=${Math.round(bandLeft)}..${Math.round(bandRight)}`
        + (last.first ? ` first="${last.first}"` : ""),
    };
  }

  // ── the two numbers on a profile ──────────────────────────────────────────────
  // Read by what is WRITTEN, not by where it sits: the smallest element whose
  // whole text is a number and its word ("4,864 posts"). Measured on the live
  // profile — the stats are spans and anchors with href="#", so there is nothing
  // structural to key on, but that number-then-word pairing holds for each.
  //
  // The exact value comes from `title`, which Instagram fills in ONLY when it
  // shortened what it drew (104M, title="104,256,058"). So there is no suffix to
  // parse: a title means the text was rounded, and no title means it wasn't.
  const COUNT_WORDS = {
    posts: "posts?|публикац\\S*|записей|beiträge|publicaciones|publications|posty",
    followers: "followers?|подписчик\\S*|abonnenten|seguidores|abonnés|obserwuj\\S*",
  };

  const plainNumber = (text) => {
    // Separators differ by locale (1,234 · 1 234 · 1.234), digits do not.
    const digits = String(text).replace(/[.,\s  ]/g, "");
    return /^\d+$/.test(digits) ? Number(digits) : undefined;
  };

  function readOneCount(words) {
    const re = new RegExp(`^\\s*(\\S+)\\s*\\n?\\s*(?:${words})\\s*$`, "i");
    let best = null;
    for (const el of document.querySelectorAll("span, a, div")) {
      const text = (el.innerText || "").trim();
      if (!/\d/.test(text) || !re.test(text)) continue;
      if (!best || el.querySelectorAll("*").length < best.querySelectorAll("*").length) best = el;
    }
    if (!best) return undefined;
    const titled = best.querySelector("[title]")?.getAttribute("title") ?? best.getAttribute("title");
    return plainNumber(titled ?? best.innerText.trim().match(re)[1]);
  }

  // Undefined for a number that isn't there or can't be read exactly — never a
  // guess. src/audience.js decides what an unreadable number means.
  const readProfileCounts = () => ({
    followers: readOneCount(COUNT_WORDS.followers),
    posts: readOneCount(COUNT_WORDS.posts),
  });

  // The header fills in AFTER the profile page arrives, and the filter asks for
  // these numbers the moment the walk from the conversation lands — so a single
  // read is a race, and losing it fails a blameless lead for the page being
  // slow. Every other read in this layer waits for what it needs; this one does
  // too, and still gives up with what the page had rather than guessing.
  const waitForProfileCounts = async (ms = 6000) => {
    const bothThere = () => {
      const counts = readProfileCounts();
      return Number.isFinite(counts.followers) && Number.isFinite(counts.posts) ? counts : null;
    };
    return (await waitFor(bothThere, ms)) || readProfileCounts();
  };

  // What the page looked like when the numbers wouldn't read. "Couldn't read
  // them" has already cost two runs: it cannot tell a page that never arrived
  // from one that stopped rendering from a word Instagram renamed. Measured on
  // the live site, a profile opened from a conversation is BLANK for the first
  // ~350ms of its client-side navigation (10 characters of text) and has its
  // numbers by ~730ms — so the character count is what says which of those this
  // was. The verdict still belongs to the worker; this only describes.
  const describeMissingCounts = () => {
    const text = document.body.innerText || "";
    const seen = Object.entries(COUNT_WORDS)
      .filter(([, words]) => new RegExp(words, "i").test(text))
      .map(([noun]) => noun);
    return `the numbers wouldn't read on ${location.pathname} — ${text.length} chars of text, `
      + (seen.length ? `${seen.join(" and ")} written on the page` : "none of the count words on the page");
  };

  Object.assign(S, {
    SEARCH_RE, isSearchField, findComposer, threadIsOpen, SEND_RE, findSendButton,
    findMessageButton, findLeadChatBox, rowHandles, probeReachability, probeExistingMessages,
    readProfileCounts, waitForProfileCounts, describeMissingCounts,
  });
})();
