// quota.js — what the platform allows the send run to do.
//
// A run needs a connected Artist Outreach account with an active plan, and
// every automated message (first DM or follow-up) takes one unit of the day's
// allowance BEFORE it goes out: Starter has 10 a day, Pro is unlimited (only
// counted). A unit is given back when the send doesn't happen.
//
// The checks fail closed: if the platform can't be reached, the run doesn't
// start (or pauses) instead of sending past a limit nobody could verify.

import { apiFetch, getConnection, PlatformError } from "./api.js";
import { DEFAULT_ORIGIN } from "./config.js";

const tz = () => new Date().getTimezoneOffset();

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function explain(error, extra = {}) {
  switch (error) {
    case "not_connected":
    case "invalid_token":
      return `Connect your Artist Outreach account first: open ${extra.origin || DEFAULT_ORIGIN}, ` +
        "account menu (top right) → Connect extension.";
    case "subscription_required":
      return "Your Artist Outreach plan isn't active — choose a plan in the app to send messages.";
    case "daily_limit":
      return `You've used today's ${plural(extra.limit ?? 10, "automated DM")} on the Starter plan. ` +
        "The run will pick up again tomorrow — or upgrade to Pro for unlimited DMs.";
    case "network":
      return "Couldn't reach Artist Outreach to check your plan — check your connection and try again.";
    default:
      return `Artist Outreach said: ${error}`;
  }
}

// Before a run starts: connected, plan active, something left today.
export async function checkRunAllowed() {
  const conn = await getConnection();
  if (!conn) return { ok: false, error: "not_connected", message: explain("not_connected") };
  try {
    const q = await apiFetch(`/quota?tz=${tz()}`);
    if (q.limit != null && q.remaining <= 0) {
      return { ok: false, error: "daily_limit", message: explain("daily_limit", q), quota: q };
    }
    return { ok: true, quota: q };
  } catch (e) {
    const error = e instanceof PlatformError ? e.message : "network";
    return { ok: false, error, message: explain(error, { origin: conn.origin }) };
  }
}

// Right before one automated send. Resolves to { ok, day, used, limit, remaining }.
export async function claimDm() {
  try {
    const r = await apiFetch("/quota/claim", { method: "POST", body: { tz: tz() } });
    return r.ok ? r : { ...r, ok: false, error: "daily_limit", message: explain("daily_limit", r) };
  } catch (e) {
    const error = e instanceof PlatformError ? e.message : "network";
    // A 200 with ok:false is not an exception; anything thrown is the platform
    // refusing (no token, no plan) or not answering.
    return { ok: false, error, message: explain(error) };
  }
}

export async function releaseDm(day) {
  if (!day) return;
  try { await apiFetch("/quota/release", { method: "POST", body: { day } }); } catch (_) { /* best effort */ }
}

export function describeQuota(q) {
  if (!q) return "";
  if (q.limit == null) return `${q.plan === "pro" ? "Pro" : "Your"} plan · unlimited automated DMs (${q.used} today)`;
  return `Starter plan · ${q.remaining} of ${q.limit} automated DMs left today`;
}
