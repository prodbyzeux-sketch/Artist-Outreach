// messages.js — the message variants and the preview line. Moved out of app.js
// unchanged: one variant is picked at random per lead, spintax and {variables}
// are resolved at send time.

import { setMessages, newId } from "../storage.js";
import { applySpintax, personalize, allHandles, mergedLookup } from "../spintax.js";
import { $, debounce } from "./dom.js";

let messages = [];
let getTables = () => [];      // set by init — the preview needs the first lead's row
let lastFocused = null;

const save = () => setMessages(messages);
const saveDebounced = debounce(save, 300);

export const allMessages = () => messages;

// Variable chips call this to drop a token into whichever variant was last edited.
export function insertToken(token) {
  const ta = lastFocused;
  if (!ta) return;
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, start) + token + ta.value.slice(end);
  ta.focus();
  ta.selectionStart = ta.selectionEnd = start + token.length;
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

export function renderMessages() {
  const list = $("messageList");
  list.innerHTML = "";
  messages.forEach((m) => {
    const wrap = document.createElement("div");
    wrap.className = "msg";

    const ta = document.createElement("textarea");
    ta.rows = 3;
    ta.value = m.text;
    ta.placeholder = "Hey {name?}! Loved your work {🔥|✨|💫}";
    ta.addEventListener("focus", () => { lastFocused = ta; });
    ta.addEventListener("input", () => {
      m.text = ta.value;
      saveDebounced();
      renderMessagePreview();
    });

    const del = document.createElement("button");
    del.className = "btn btn--icon btn--ghost";
    del.textContent = "✕";
    del.title = "Remove";
    del.addEventListener("click", () => {
      messages = messages.filter((x) => x.id !== m.id);
      save();
      renderMessages();
      renderMessagePreview();
    });

    wrap.append(ta, del);
    list.append(wrap);
  });
  if (!lastFocused) lastFocused = list.querySelector("textarea");
}

export function renderMessagePreview() {
  const first = messages.find((m) => m.text.trim());
  const out = $("messagePreview");
  if (!first) { out.textContent = "—"; return; }
  const tables = getTables();
  const lookup = mergedLookup(tables);
  const firstHandle = allHandles(tables)[0];
  const vars = (firstHandle && lookup[firstHandle]) || {};
  out.textContent = personalize(applySpintax(first.text), vars) || "(empty)";
}

export function initMessages(loaded, tableGetter) {
  messages = loaded.length ? loaded : [{ id: newId("m"), text: "" }];
  getTables = tableGetter;

  $("addMessage").addEventListener("click", () => {
    messages.push({ id: newId("m"), text: "" });
    save();
    renderMessages();
    const tas = $("messageList").querySelectorAll("textarea");
    lastFocused = tas[tas.length - 1];
    lastFocused?.focus();
  });

  renderMessages();
  renderMessagePreview();
}
