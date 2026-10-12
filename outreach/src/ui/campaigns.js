// campaigns.js — the switcher at the top of the page.
//
// A campaign owns the leads, the messages, the follow-up steps and the settings
// (see src/storage.js), which is nearly everything on this page. So switching
// RELOADS rather than re-rendering: every section already builds itself from
// storage on load, and a reload is the only way to be sure nothing is left
// holding the campaign you just walked away from.

import {
  getCampaigns, activeCampaignId, setActiveCampaign, createCampaign,
  renameCampaign, deleteCampaign, getRunState, getLeads,
} from "../storage.js";
import { $ } from "./dom.js";

let list = [];
let activeId = null;
let locked = false;
let commit = async () => {};   // set by init — flushes what the page is holding

const index = () => list.findIndex((c) => c.id === activeId);
const active = () => list[index()];

// A run reads the leads and the messages of whichever campaign is ACTIVE, once
// per lead, from the worker. The controls go dead while one is going, and this
// answers the click that got in before the lock did — the page learns a run
// started from a message, which can arrive after the press.
const busy = async () => locked || (await getRunState()).running;

function render() {
  const i = index();
  $("campaignName").value = active()?.name || "";
  $("campaignName").disabled = locked;
  $("campaignPrev").disabled = locked || i <= 0;
  $("campaignNext").disabled = locked || i >= list.length - 1;
  $("campaignNew").disabled = locked;
  $("campaignDelete").disabled = locked;
  $("campaignDelete").hidden = list.length < 2;
  // "1 of 1" is noise on the only campaign there is.
  $("campaignCount").textContent = list.length > 1 ? `${i + 1} of ${list.length}` : "";
}

// Leaving means whatever the page is still holding — a message typed a moment
// ago, a setting nudged — belongs to the campaign being left, not the one being
// opened. Written before the pointer moves, or a debounced save would land in
// the wrong campaign, or nowhere at all once the reload starts.
async function leaveFor(action) {
  if (await busy()) return;
  await commit();
  await action();
  location.reload();
}

const step = (delta) => {
  const next = list[index() + delta];
  if (next) leaveFor(() => setActiveCampaign(next.id));
};

async function removeActive() {
  if (await busy()) return;
  const { id, name } = active();
  const n = (await getLeads()).filter((l) => !l.removed).length;
  const asked = `Delete "${name}"?\n\n`
    + (n ? `Its ${n} lead${n === 1 ? "" : "s"} go with it, and everything sent to them leaves the dashboard. ` : "")
    + "Its messages, follow-up steps and settings are deleted too.\n\nThere is no way back.";
  if (!confirm(asked)) return;
  await deleteCampaign(id);
  location.reload();
}

export function setCampaignsLocked(v) {
  locked = v;
  render();
}

export async function initCampaigns({ commitCurrent }) {
  commit = commitCurrent;
  list = await getCampaigns();
  activeId = await activeCampaignId();
  render();

  $("campaignPrev").addEventListener("click", () => step(-1));
  $("campaignNext").addEventListener("click", () => step(1));
  $("campaignNew").addEventListener("click", () => leaveFor(() => createCampaign("")));
  $("campaignDelete").addEventListener("click", removeActive);

  const name = $("campaignName");
  // A campaign with no name is a row of arrows pointing at nothing, so an empty
  // box comes back rather than being saved.
  name.addEventListener("change", async () => {
    const typed = name.value.trim();
    if (!typed) return render();
    list = await renameCampaign(activeId, typed);
    render();
  });
  name.addEventListener("keydown", (e) => { if (e.key === "Enter") name.blur(); });
}
