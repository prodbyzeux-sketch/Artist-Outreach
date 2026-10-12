// platform.js — "From Artist Outreach…": brings the artists saved in the web
// app in as one more file of the campaign. Each row carries its id (ao_id) so
// sends and replies flow back to the right artist (platform/sync.js).

import { getConnection, folders as fetchFolders, prospects as fetchProspects, PlatformError } from "../../../platform/api.js";
import { DEFAULT_ORIGIN } from "../../../platform/config.js";
import { addTables } from "./tables.js";
import { $ } from "./dom.js";

const HEADERS = ["instagram", "name", "listeners", "ig_followers", "reference", "spotify", "ao_id"];
const STATUS_LABEL = { pending: "not contacted", saved: "all saved", contacted: "contacted" };

let conn = null;

const ERRORS = {
  not_connected: "Not connected — connect the extension from Artist Outreach.",
  invalid_token: "The connection was revoked. Connect the extension again from Artist Outreach.",
  subscription_required: "Your Artist Outreach subscription isn't active.",
  network: "Couldn't reach Artist Outreach. Check your connection.",
};
const explain = (e) => ERRORS[e?.message] || `Something went wrong (${e?.message || e}).`;

function showError(e) {
  const box = $("aoError");
  box.textContent = e ? explain(e) : "";
  box.hidden = !e;
}

export function buildTable(list, { folderName, status }) {
  const rows = list.map((p) => [
    p.handle,
    p.name || "",
    p.listeners != null ? String(p.listeners) : "",
    p.igFollowers != null ? String(p.igFollowers) : "",
    p.reference || "",
    p.spotify || "",
    p.id,
  ]);
  return {
    headers: HEADERS,
    rows,
    matchColumn: 0,
    fileName: `Artist Outreach · ${folderName} · ${STATUS_LABEL[status] || status}`,
    importedAt: Date.now(),
    source: "artist-outreach",
  };
}

async function open() {
  showError(null);
  $("aoStatusLine").textContent = "";
  conn = await getConnection();
  $("aoConnect").hidden = !!conn;
  $("aoForm").hidden = !conn;
  $("aoWho").textContent = conn ? `Connected as ${conn.email || "your account"} · ${new URL(conn.origin).host}` : "";
  $("aoDialog").showModal();
  if (!conn) return;

  const select = $("aoFolder");
  select.innerHTML = "";
  const add = (value, label) => { const o = document.createElement("option"); o.value = value; o.textContent = label; select.append(o); };
  add("", "All folders");
  add("none", "Not in a folder");
  try {
    for (const f of await fetchFolders()) add(f.id, f.name);
  } catch (e) {
    showError(e);
    if (e instanceof PlatformError && e.status === 401) { $("aoForm").hidden = true; $("aoConnect").hidden = false; }
  }
}

async function runImport() {
  const go = $("aoGo");
  const folder = $("aoFolder").value;
  const status = $("aoStatus").value;
  const folderName = $("aoFolder").selectedOptions[0]?.textContent || "All folders";
  showError(null);
  go.disabled = true;
  $("aoStatusLine").textContent = "loading…";
  try {
    const list = await fetchProspects({ folder, status });
    if (!list.length) {
      $("aoStatusLine").textContent = "no artists with Instagram there";
      return;
    }
    const table = buildTable(list, { folderName, status });
    if (!addTables([table], `${table.fileName} · ${list.length} artists`)) {
      showError(new Error("A run is using the queue — stop it to import."));
      return;
    }
    $("aoDialog").close();
  } catch (e) {
    showError(e);
    $("aoStatusLine").textContent = "";
  } finally {
    go.disabled = false;
  }
}

export function initPlatform() {
  const btn = $("aoImport");
  if (!btn) return;
  btn.addEventListener("click", () => { open().catch(showError); });
  $("aoGo").addEventListener("click", runImport);
  $("aoOpen").addEventListener("click", () => chrome.tabs.create({ url: DEFAULT_ORIGIN }));
}
