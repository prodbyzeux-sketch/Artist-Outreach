// settings.js — the settings form. Moved out of app.js; the only change is that
// message selection, dry run and the profile-scroll count are gone, and with
// them the format-dependent relabelling that claimed skip-existing needed Just
// DM (it applies to every path now).

import { FORMATS, HAND_SKINS, setSettings } from "../storage.js";
import { $, debounce } from "./dom.js";

// Checkbox id / settings key for each format (fmtJustDM ↔ formatJustDM).
const fmtId = (f) => `fmt${f[0].toUpperCase()}${f.slice(1)}`;
const fmtKey = (f) => `format${f[0].toUpperCase()}${f.slice(1)}`;

let settings = {};
let onChanged = () => {};

const save = () => setSettings(settings);
const saveDebounced = debounce(save, 300);
const toInt = (v) => Math.max(0, parseInt(v, 10) || 0);

export const currentSettings = () => settings;

function renderSettings() {
  FORMATS.forEach((f) => { $(fmtId(f)).checked = !!settings[fmtKey(f)]; });
  $("skipExisting").checked = !!settings.skipExisting;
  $("perMin").value = Math.round(settings.perLeadDelayMin / 1000);
  $("perMax").value = Math.round(settings.perLeadDelayMax / 1000);
  $("typingSpeed").value = settings.typingSpeed;
  $("typingSpeedLabel").textContent = `${Number(settings.typingSpeed).toFixed(1)}×`;
  $("maxPerRun").value = settings.maxPerRun;
  $("followupsEnabled").checked = !!settings.followupsEnabled;
  $("followupAfterHours").value = settings.followupAfterHours;
  $("followupMaxPerRun").value = settings.followupMaxPerRun;
  $("notifyOnFinish").checked = !!settings.notifyOnFinish;
  renderAudience();
  renderSkins();
}

const AUDIENCE_BOUNDS = ["minFollowers", "maxFollowers", "minPosts"];

// Numbers that can't do anything until the switch is on read as a setting that
// is broken, so they follow the switch.
function renderAudience() {
  $("audienceFilter").checked = !!settings.audienceFilter;
  AUDIENCE_BOUNDS.forEach((key) => {
    $(key).value = settings[key];
    $(key).disabled = !settings.audienceFilter;
  });
}

// Built from HAND_SKINS rather than written into the markup, so adding a pair of
// hands is one line in storage.js and nothing else.
function renderSkins() {
  const box = $("skinPicker");
  box.innerHTML = "";
  box.hidden = HAND_SKINS.length < 2;   // a choice of one is not a choice
  for (const s of HAND_SKINS) {
    const label = document.createElement("label");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "handSkin";
    radio.value = s.id;
    radio.checked = s.id === settings.handSkin;
    radio.addEventListener("change", () => {
      settings.handSkin = s.id;
      save();
      onChanged();
    });
    const span = document.createElement("span");
    span.textContent = s.name;
    label.append(radio, span);
    box.append(label);
  }
}

// Notifications are an OPTIONAL permission, so the switch is a request, not a
// preference: Chrome puts its own prompt in front of it and the user can say no.
// Storing "on" without the grant would mean a run that promises to tell you it
// finished and then doesn't.
async function askForNotifications(box) {
  if (!box.checked) {
    settings.notifyOnFinish = false;
    save();
    chrome.permissions.remove({ permissions: ["notifications"] }).catch(() => {});
    return;
  }
  // Must be called straight out of the click — an await first and Chrome
  // rejects it as a request without a user gesture.
  const granted = await chrome.permissions.request({ permissions: ["notifications"] }).catch(() => false);
  box.checked = granted;
  settings.notifyOnFinish = granted;
  save();
  if (granted) showTestNotice();
}

// Granted is not the same as visible. macOS can be refusing Chrome's
// notifications entirely, or sitting in a Focus mode, and Chrome reports nothing
// about either — the run ends hours later in silence and the switch still says
// on. One notification right now is the only way to find that out while there is
// still something to do about it.
function showTestNotice() {
  if (!chrome.notifications) {
    $("notifyNote").textContent = "— granted, but Chrome hasn't handed the API over yet. Reload this page.";
    return;
  }
  chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("outreach/icons/icon-128.png"),
    title: "Artist Outreach — notifications are on",
    message: "This is what you'll get when a run ends.",
  }).catch(() => {});
  $("notifyNote").textContent = "— a test notification just went out. Nothing? macOS is holding it: "
    + "System Settings → Notifications → Google Chrome.";
}

// The run bar offers the cap again when a capped run stopped part-way, and that
// choice sets it. It goes through here rather than storage: this module holds
// the settings in memory and would overwrite a value written behind its back.
export function setMaxPerRun(value) {
  settings.maxPerRun = toInt(value);
  $("maxPerRun").value = settings.maxPerRun;
  save();
  return settings.maxPerRun;
}

function bind(id, key, transform = (v) => v) {
  const el = $(id);
  const evt = el.type === "checkbox" || el.tagName === "SELECT" ? "change" : "input";
  el.addEventListener(evt, () => {
    settings[key] = transform(el.type === "checkbox" ? el.checked : el.value);
    saveDebounced();
    onChanged();
  });
}

export function initSettings(loaded, changed = () => {}) {
  settings = loaded;
  onChanged = changed;
  renderSettings();

  // Send paths — any combination; the engine picks one at random per lead.
  FORMATS.forEach((f) => {
    $(fmtId(f)).addEventListener("change", () => {
      settings[fmtKey(f)] = $(fmtId(f)).checked;
      save();
    });
  });

  $("typingSpeed").addEventListener("input", () => {
    settings.typingSpeed = parseFloat($("typingSpeed").value) || 1;
    $("typingSpeedLabel").textContent = `${settings.typingSpeed.toFixed(1)}×`;
    saveDebounced();
  });

  $("notifyOnFinish").addEventListener("change", (e) => askForNotifications(e.target));

  $("audienceFilter").addEventListener("change", () => {
    settings.audienceFilter = $("audienceFilter").checked;
    save();
    renderAudience();
  });
  AUDIENCE_BOUNDS.forEach((key) => bind(key, key, toInt));

  bind("skipExisting", "skipExisting");
  bind("perMin", "perLeadDelayMin", (v) => toInt(v) * 1000);
  bind("perMax", "perLeadDelayMax", (v) => toInt(v) * 1000);
  bind("maxPerRun", "maxPerRun", toInt);
  bind("followupsEnabled", "followupsEnabled");
  bind("followupAfterHours", "followupAfterHours", (v) => Math.max(1, toInt(v)));
  bind("followupMaxPerRun", "followupMaxPerRun", toInt);
}
