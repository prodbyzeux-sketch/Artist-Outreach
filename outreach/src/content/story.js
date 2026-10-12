// story.js — reply to a live story or a highlight.
//
// Verified against the live desktop viewer: clicking the header avatar (whose
// story ring is a <canvas>, with no text or class to key on) goes
// /<user>/ → /stories/<user>/; the reply box is a real <textarea>; and the Send
// button DOES NOT EXIST until that textarea has text, so it can only be looked
// up after typing. Escape returns to the profile.

(() => {
  "use strict";
  const S = globalThis.__igs;
  const {
    humanPause, step, waitFor, pressEnter, pressEscape, realClick, typeAndSubmit,
    scrollToTop, isSearchField, findSendButton, probeReachability, runReplyToPost, pageWasBroken,
    submitsMade,
  } = S;

  // Which story surface this profile offers, preferring a live story over a
  // highlight reel (mirrors Tabels' detectStoryEntryPoint).
  function findStoryEntry() {
    const ariaHit = [...document.querySelectorAll('header [role="button"], header button, header a, [role="link"]')]
      .find((el) => /story|geschichte|истори/.test((el.getAttribute("aria-label") || "").toLowerCase()));
    if (ariaHit) return { kind: "story", el: ariaHit };

    const img = document.querySelector("header img");
    if (img) {
      let p = img.parentElement;
      for (let i = 0; i < 5 && p; i++) {
        if (p.querySelector("canvas")) {
          return { kind: "story", el: p.closest('[role="button"], button, a') || p };
        }
        p = p.parentElement;
      }
    }
    const hi = [...document.querySelectorAll('ul li button, ul li a, [role="menuitem"], a[href*="/highlights/"]')]
      .find((b) => { const r = b.getBoundingClientRect(); return r.width > 40 && r.height > 40 && b.querySelector("img"); });
    return hi ? { kind: "highlight", el: hi } : null;
  }

  // The story viewer's reply box. The size floor matters: the viewer also
  // carries collapsed inputs that would otherwise win the "lowest field" pick.
  function findStoryReplyField() {
    const re = /nachricht senden|send message|message|antworten|reply|ответить|сообщение/i;
    const editable = [...document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"], input:not([type])')]
      .filter((el) => !isSearchField(el))
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 40 && r.height > 8; });
    const byPlaceholder = editable.find((el) =>
      re.test(el.getAttribute("placeholder") || "") || re.test(el.getAttribute("aria-label") || ""));
    if (byPlaceholder) return byPlaceholder;
    editable.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    return editable[0] || null;
  }

  async function leaveStoryViewer() {
    await pressEscape();
    await waitFor(() => (/\/stories\//.test(location.pathname) ? null : true), 5000);
    await humanPause(600, 1200);
  }

  // ── FLOW C — reply to a story / highlight ───────────────────────────────────
  async function runReplyToStory({ username, message, settings, speed }) {
    const reach = probeReachability();
    if (reach === "notFound") return { status: "skipped", reason: "profile not found" };
    if (reach === "privateLocked") return { status: "skipped", reason: "private profile" };

    // The ring and the highlights row live at the very top of the profile. Get
    // there before aiming at them — Tabels learned this the hard way: with the
    // page left scrolled into the post grid, the tap landed on whatever sat at
    // the off-screen element's clamped coordinates instead of the ring.
    await scrollToTop();
    await humanPause(500, 900);

    // Waited for, not glanced at: the ring and the highlights row are the last
    // things a profile paints, and Instagram's error screen — which leaves the
    // page blank behind it — arrives a second or two after the navigation. Both
    // read as "this person has no story" if you look only once, on arrival.
    let entry = await waitFor(findStoryEntry, 4000);
    if (!entry && await pageWasBroken()) entry = await waitFor(findStoryEntry, 6000);
    if (!entry) {
      // Nothing to reply to → reply-to-post (which itself falls back to just-DM).
      // With the counts, because "they had a story and it went to a post anyway"
      // is otherwise impossible to tell from "the header hadn't painted yet".
      const tiles = document.querySelectorAll('ul li button, ul li a, [role="menuitem"], a[href*="/highlights/"]');
      step("no story or highlight → replying to a post"
        + ` (header=${document.querySelectorAll("header").length}`
        + ` ring=${document.querySelectorAll("header canvas").length}`
        + ` tiles=${tiles.length})`);
      return runReplyToPost({ username, message, settings, speed });
    }
    step(entry.kind === "story" ? "opening the live story" : "opening the first highlight");
    await realClick(entry.el);

    // Only ever inside the viewer: once it closes, "the lowest editable field"
    // would happily resolve to something on the profile underneath.
    const replyField = () => (/\/stories\//.test(location.pathname) ? findStoryReplyField() : null);
    let field = await waitFor(replyField, 7000);
    // The viewer is a client-side navigation of its own, and those are exactly
    // what Instagram fails — a story that "takes no replies" is often a story
    // that never opened.
    if (!field && await pageWasBroken()) field = await waitFor(replyField, 7000);
    if (!field) {
      // Opened, but this story takes no replies. Leave the viewer first —
      // reply-to-post expects to be standing on the profile, and probing the
      // story viewer instead would report a bogus "DMs closed".
      step("story takes no replies → replying to a post");
      await leaveStoryViewer();
      return runReplyToPost({ username, message, settings, speed });
    }
    // Clicking the reply box focuses it, which pauses the story — that pause is
    // what buys us the time to type. Enter inserts a newline here, so the Send
    // button (which appears once there is text) is the real submit; Enter stays
    // as a fallback for layouts that do submit on it.
    const submitted = submitsMade();
    const result = await typeAndSubmit(replyField, message, speed, {
      submit: async () => {
        const send = await waitFor(findSendButton, 2500);
        if (send) await realClick(send);
        else await pressEnter();
      },
    });
    // A reply box that is there but cannot be reached — observed live, the
    // viewer had it covered by a <section> in the corner — is the same thing to
    // this lead as a story that takes no replies, and their posts take the same
    // message. Only while nothing has been submitted, or this would send twice.
    if (result.status === "failed" && submitsMade() === submitted) {
      step(`the story reply box wouldn't take the message (${result.error}) → replying to a post`);
      await leaveStoryViewer();
      return runReplyToPost({ username, message, settings, speed });
    }
    return result;
  }

  Object.assign(S, { findStoryEntry, findStoryReplyField, leaveStoryViewer, runReplyToStory });
})();
