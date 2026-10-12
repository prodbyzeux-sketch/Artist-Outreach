// post.js — reply to a post: open one from the grid, tap Share, pick the lead
// out of the recipient list, type, click Send.
//
// The share sheet is the trickiest surface in the extension. Verified against
// the live UI: a role="dialog" holding a "Search…" input, a single bottom
// "Send" button that exists from the moment it opens (so it proves nothing),
// and a "Write a message…" input rendered ONLY while a recipient is selected.
// Every finder is scoped to the sheet — the post modal behind it also has a
// text box ("Add a comment…") and its own buttons.

(() => {
  "use strict";
  const S = globalThis.__igs;
  const {
    norm, handle, humanPause, step, isVisible, waitFor,
    realClick, fillField, typeAndSubmit, humanScrollProfile, pageWasBroken,
    isSearchField, SEND_RE, rowHandles, probeReachability, runJustDM,
  } = S;

  // Dwell on the profile before opening a post. Not about loading the grid —
  // that arrives on its own — but about not landing on someone's page and
  // clicking a post in the same second.
  const PROFILE_SCROLLS = 2;

  // ── the profile's post grid ───────────────────────────────────────────────────
  const isPostTile = (x) => {
    const r = x.getBoundingClientRect();
    return r.width > 40 && r.height > 40 && !!x.querySelector("img");
  };
  const postTiles = () =>
    [...document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')].filter(isPostTile);

  const postGridHasPosts = () => postTiles().length > 0;
  function pickRandomPost() {
    const posts = postTiles();
    return posts.length ? posts[Math.floor(Math.random() * posts.length)] : null;
  }

  // The post's Share (paper-plane) icon. IG inserted a **Repost** button into the
  // action row, so picking "the 3rd icon" now lands on Repost. Instead we identify
  // Share by ELIMINATION: the action-row icon that is NOT Like / Comment / Save /
  // Repost / nav. Robust to the Repost shuffle and to aria wording per locale.
  const REPOST_RE = /repost|репост|повторн|condividi di nuovo|volver a publicar|reposter|repostar/i;
  function findShareButton() {
    const likeRe = /like|liked|gefällt|нравится|me gusta|mi piace|j'aime|curtir/i;
    const commentRe = /comment|kommentar|коммент|comentar|commenta|commenter/i;
    const saveRe = /save|saved|speichern|gespeichert|сохранить|сохранено|guardar|salva|enregistrer|bookmark/i;
    const navRe = /home|explore|reels|messages|profile|notifications|new post|главная|интересное|entdecken|profil/i;
    const shareRe = /share|direct|teilen|senden|поделиться|отправить|compartir|condividi|invia|partager|envoyer|enviar/i;
    const isOther = (al) => likeRe.test(al) || commentRe.test(al) || saveRe.test(al) || REPOST_RE.test(al) || navRe.test(al);
    const wrap = (el) => (el ? el.closest('[role="button"], button, a') || el.parentElement : null);

    // Small icons in the content area (exclude the top/bottom nav bands).
    const icons = [...document.querySelectorAll("svg[aria-label]")].filter((s) => {
      const r = s.getBoundingClientRect();
      return r.width >= 14 && r.width <= 44 && r.height >= 14 && r.height <= 44 &&
        r.top > 60 && r.bottom < innerHeight - 60;
    });

    // 1) An explicit Share label that isn't one of the other actions.
    const labelHit = icons.find((s) => {
      const al = s.getAttribute("aria-label") || "";
      return shareRe.test(al) && !isOther(al);
    });
    if (labelHit) return wrap(labelHit);

    // 2) Elimination inside the lowest dense action row (≥3 icons): drop
    //    like/comment/save/repost/nav; the leftmost survivor is Share.
    const byRow = {};
    for (const s of icons) {
      const y = Math.round(s.getBoundingClientRect().top / 8) * 8;
      (byRow[y] = byRow[y] || []).push(s);
    }
    const rows = Object.values(byRow).filter((r) => r.length >= 3)
      .sort((a, b) => b[0].getBoundingClientRect().top - a[0].getBoundingClientRect().top);
    if (rows.length) {
      const row = rows[0].sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      const share = row.find((s) => !isOther(s.getAttribute("aria-label") || ""));
      if (share) return wrap(share);
    }
    return null;
  }

  // ── the share sheet ───────────────────────────────────────────────────────────
  // The recipient list is [role="option"] rows (aria-selected, sometimes a
  // checkbox) — but ONLY while a search is in progress. Before typing, some
  // variants show a grid of plain [role="button"] tiles instead, and the moment
  // a recipient is picked IG clears the search and drops the list entirely. So
  // the sheet is identified by its search field, which is the one thing present
  // throughout; keying on the options made the sheet "disappear" both before the
  // search and right after the pick.
  function findShareSheet() {
    const dialogs = [...document.querySelectorAll('div[role="dialog"]')].filter(isVisible);
    for (let i = dialogs.length - 1; i >= 0; i--) {
      if ([...dialogs[i].querySelectorAll("input")].some(isSearchField)) return dialogs[i];
    }
    return null;
  }

  const isRowSelected = (row) =>
    row.getAttribute("aria-selected") === "true" || !!row.querySelector('input[type="checkbox"]:checked');

  // Exact @handle only, never a "first row" guess: IG's search is fuzzy — a
  // handle also returns "<handle>yy", "<handle>OFFICIALFANPAGE" and other
  // look-alikes, so a guess shares the post to a stranger.
  function findRecipientRow(sheet, username) {
    const uLow = handle(username);
    if (!uLow) return null;
    return [...sheet.querySelectorAll('[role="option"]')].filter(isVisible)
      .find((row) => rowHandles(row).includes(uLow)) || null;
  }

  const findSheetSendButton = (sheet) =>
    [...sheet.querySelectorAll('[role="button"], button')].filter(isVisible).find((b) =>
      SEND_RE.test(norm(b.textContent)) || SEND_RE.test(norm(b.getAttribute("aria-label")))
    ) || null;

  const findSheetMessageField = (sheet) =>
    [...sheet.querySelectorAll('input[type="text"], input:not([type]), textarea, [contenteditable="true"]')]
      .filter((el) => !isSearchField(el))
      .filter(isVisible)[0] || null;

  // ── FLOW B — reply to a post ────────────────────────────────────────────────
  async function runReplyToPost({ username, message, settings, speed }) {
    const reach = probeReachability();
    if (reach === "notFound") return { status: "skipped", reason: "profile not found" };
    if (reach === "privateLocked") return { status: "skipped", reason: "private profile" };

    await humanScrollProfile(PROFILE_SCROLLS);
    let hasPosts = await waitFor(() => (postGridHasPosts() ? true : null), 8000);
    // An empty grid is not proof of an empty profile: Instagram's own error
    // screen arrives after the navigation and leaves the page blank behind it.
    if (!hasPosts && await pageWasBroken()) {
      hasPosts = await waitFor(() => (postGridHasPosts() ? true : null), 8000);
    }
    if (!hasPosts) {
      // No posts to reply to → fall back to a plain DM.
      step("no posts to reply to → sending a plain DM");
      return runJustDM({ username, message, settings, speed });
    }
    const post = pickRandomPost();
    if (!post) return { status: "failed", error: "the post grid emptied before a post could be opened" };
    await realClick(post);
    await humanPause(1400, 2600);
    step("opened a post");

    const share = await waitFor(findShareButton, 7000);
    if (!share) return { status: "failed", error: "Share button not found on post" };
    step("tapping Share (paper-plane)");
    await realClick(share);

    if (!(await waitFor(findShareSheet, 8000))) {
      return { status: "failed", error: "share sheet didn't open — wrong icon? (not Repost)" };
    }
    const currentSearch = () => {
      const open = findShareSheet();
      return open ? [...open.querySelectorAll("input")].find(isSearchField) : null;
    };
    if (!(await waitFor(currentSearch, 5000))) {
      return { status: "failed", error: "no search field in the share sheet" };
    }
    await humanPause();
    // Typed, never pasted — the per-keystroke events are what drive IG's search.
    // React rebuilds the sheet while results stream in and can swap the input out
    // from under us, so the box is read back and re-filled until it holds the
    // handle; typing again on top of a half-typed one searches for nonsense.
    const typed = await fillField(currentSearch, handle(username), speed);
    if (typed) return { status: "failed", error: typed };

    // Never hold on to a row: React re-renders the list as search results
    // arrive, and a click on a node captured before the re-render lands on a
    // detached element and silently does nothing. Re-resolve on every touch.
    const currentRow = () => {
      const open = findShareSheet();
      return open ? findRecipientRow(open, username) : null;
    };

    // What the sheet says about the selection, strongest evidence first. Reading
    // aria-selected off a re-resolved row is NOT enough on its own: the moment a
    // recipient is picked IG clears the search box and removes the option list
    // altogether (observed live — 0 options, nothing reads selected anywhere),
    // so that check reports a failure on a send that actually worked. The
    // message field is the second signal: it appears only while someone is
    // selected, and requiring that nobody ELSE reads selected keeps it safe.
    // Which recipient is picked rests on the exact-handle match plus the
    // hit-test done immediately before the click — once the list is gone the
    // sheet no longer says who it was.
    const selectionState = () => {
      const open = findShareSheet();
      if (!open) return "sheetGone";
      const selected = [...open.querySelectorAll('[role="option"]')].filter(isRowSelected);
      if (selected.some((row) => rowHandles(row).includes(handle(username)))) return "ours";
      if (selected.length) return "someoneElse";
      return findSheetMessageField(open) ? "implied" : "none";
    };

    // IG's search is async and fuzzy — wait for the row whose @handle matches
    // exactly. No match means this lead is not sendable here; skipping is the
    // only safe outcome (the old "take the first row" guess sent to strangers).
    if (!(await waitFor(currentRow, 8000))) {
      return { status: "skipped", reason: `@${handle(username)} not in the share list` };
    }

    await humanPause(1200, 2200); // let the result list settle before clicking

    const row = currentRow();
    if (!row) return { status: "failed", error: "the matched row disappeared before the click" };
    await realClick(row);
    const picked = await waitFor(() => {
      const state = selectionState();
      return state === "none" ? null : state; // nothing happened yet — keep polling
    }, 5000);
    if (picked === "someoneElse") {
      return { status: "failed", error: "the click selected a different recipient" };
    }
    if (picked !== "ours" && picked !== "implied") {
      return { status: "failed", error: `selecting the recipient didn't take (${picked || "no change"})` };
    }
    step(`selected @${handle(username)}`);

    // The message field is rendered only while a recipient is selected.
    const sheetMessageField = () => {
      const open = findShareSheet();
      return open ? findSheetMessageField(open) : null;
    };
    if (!(await waitFor(sheetMessageField, 5000))) {
      return { status: "failed", error: "message field not found in share dialog" };
    }
    step("typing & clicking Send");

    // The share sheet does NOT submit on Enter — click its Send button. After a
    // delivered share IG sometimes resets the sheet and sometimes leaves the
    // selection standing, so sheet state is not a usable confirmation; the error
    // toast is. A missing Send button is a real failure, so it throws.
    return typeAndSubmit(sheetMessageField, message, speed, {
      submit: async () => {
        const open = findShareSheet();
        const send = open && findSheetSendButton(open);
        if (!send) throw new Error("Send button not found in the share dialog");
        await realClick(send);
      },
    });
  }

  Object.assign(S, {
    postGridHasPosts, pickRandomPost, findShareButton, findShareSheet,
    findRecipientRow, findSheetSendButton, findSheetMessageField, runReplyToPost,
  });
})();
