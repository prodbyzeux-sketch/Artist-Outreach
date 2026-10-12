// followups.js (ui) — the follow-up steps and their two numbers.
//
// Deliberately the same editor as the message variants, because it is the same
// job. The one difference is what the list MEANS: message variants are a bag
// one is drawn from, follow-up steps are a sequence — step 2 only ever goes out
// to someone who already had step 1. That is why the rows are numbered.

import { setFollowups, newId } from "../storage.js";
import { applySpintax, personalize, allHandles, mergedLookup } from "../spintax.js";
import { $, debounce } from "./dom.js";

let steps = [];
let getTables = () => [];
let onChanged = () => {};

const save = () => setFollowups(steps);
const saveDebounced = debounce(save, 300);

export const allFollowups = () => steps;

export function renderFollowups() {
  const list = $("followupList");
  list.innerHTML = "";
  steps.forEach((step, i) => {
    const wrap = document.createElement("div");
    wrap.className = "msg msg--step";

    const num = document.createElement("span");
    num.className = "step-num";
    num.textContent = String(i + 1);
    num.title = `Follow-up ${i + 1} — goes out only after step ${i}`;

    const ta = document.createElement("textarea");
    ta.rows = 2;
    ta.value = step.text;
    ta.placeholder = i === 0
      ? "Hey {name?}, floating this back up 👋"
      : "Last one from me — worth a look?";
    ta.addEventListener("input", () => {
      step.text = ta.value;
      saveDebounced();
      renderFollowupPreview();
      onChanged();
    });

    const del = document.createElement("button");
    del.className = "btn btn--icon btn--ghost";
    del.textContent = "✕";
    del.title = "Remove this step";
    del.addEventListener("click", () => {
      steps = steps.filter((s) => s.id !== step.id);
      save();
      renderFollowups();
      renderFollowupPreview();
      onChanged();
    });

    wrap.append(num, ta, del);
    list.append(wrap);
  });

  if (!steps.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No steps yet — nothing follows up until you write one.";
    list.append(empty);
  }
}

export function renderFollowupPreview() {
  const first = steps.find((s) => s.text.trim());
  const out = $("followupPreview");
  if (!first) { out.textContent = "—"; return; }
  const tables = getTables();
  const lookup = mergedLookup(tables);
  const firstHandle = allHandles(tables)[0];
  const vars = (firstHandle && lookup[firstHandle]) || {};
  out.textContent = personalize(applySpintax(first.text), vars) || "(empty)";
}

export function initFollowups(loaded, tableGetter, changed) {
  steps = loaded;
  getTables = tableGetter;
  onChanged = changed;

  $("addFollowup").addEventListener("click", () => {
    steps.push({ id: newId("f"), text: "" });
    save();
    renderFollowups();
    const boxes = $("followupList").querySelectorAll("textarea");
    boxes[boxes.length - 1]?.focus();
    onChanged();
  });

  renderFollowups();
  renderFollowupPreview();
}
