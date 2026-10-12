// api.js — client for the platform API (/ext/v1/*). Used by the service worker
// (sync, quota) and by the outreach page (importing prospects).
//
// The connection is { origin, token, email, pairedAt } in chrome.storage.local
// under `aoPlatform`. The web app hands the token over when pairing
// (bridge.js); it only works for these routes and never opens a web session.

import { isPlatformOrigin } from "./config.js";

export const CONNECTION_KEY = "aoPlatform";

export async function getConnection() {
  const { [CONNECTION_KEY]: c } = await chrome.storage.local.get(CONNECTION_KEY);
  return c && c.token && isPlatformOrigin(c.origin) ? c : null;
}

export async function setConnection(c) {
  await chrome.storage.local.set({ [CONNECTION_KEY]: c });
}

export async function clearConnection() {
  await chrome.storage.local.remove(CONNECTION_KEY);
}

export class PlatformError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// One call with the stored connection (or an explicit one, while pairing).
export async function apiFetch(path, { method = "GET", body, conn } = {}) {
  const c = conn || (await getConnection());
  if (!c) throw new PlatformError("not_connected", 0);
  let res;
  try {
    res = await fetch(`${c.origin}/ext/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${c.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new PlatformError("network", 0);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    // Token revoked from the web app: the connection is worthless now.
    if (res.status === 401 && !conn) await clearConnection();
    throw new PlatformError(json.error || `http_${res.status}`, res.status);
  }
  return json;
}

export const me = (conn) => apiFetch("/me", { conn });
export const folders = () => apiFetch("/folders").then((j) => j.folders || []);
export const prospects = ({ folder = "", status = "pending" } = {}) =>
  apiFetch(`/prospects?${new URLSearchParams({ folder, status })}`).then((j) => j.prospects || []);
export const postEvents = (events) => apiFetch("/events", { method: "POST", body: { events } });
export const postFollowers = (results) => apiFetch("/ig-followers", { method: "POST", body: { results } });
