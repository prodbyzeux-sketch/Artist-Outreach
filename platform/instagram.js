// instagram.js — follower counts read from the user's own browser, with their
// own Instagram session. That is what the server can't do reliably: Instagram
// blocks datacenter IPs quickly.
//
// Gentle with the account: few at a time, a pause between each, nothing while
// a send run is going (that account is busy), and a 429 makes it stop a while.

const APP_ID = "936619743392459"; // the same one instagram.com uses in the browser
const HANDLE = /^[a-z0-9._]{1,30}$/;
const MAX_PER_CALL = 30;
const CONCURRENCY = 2;
const COOLDOWN_MS = 10 * 60 * 1000;
const CACHE_MS = 24 * 60 * 60 * 1000;

const cache = new Map();      // handle → { v, ts }
let blockedUntil = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function cleanHandle(raw) {
  const h = String(raw || "").trim().replace(/^@/, "").toLowerCase();
  return HANDLE.test(h) ? h : null;
}

async function one(handle) {
  const hit = cache.get(handle);
  if (hit && Date.now() - hit.ts < CACHE_MS) return hit.v;
  const r = await fetch(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${handle}`, {
    headers: { "X-IG-App-ID": APP_ID, Accept: "application/json" },
    credentials: "include",
  });
  if (r.status === 429 || r.status === 401 || r.status === 403) {
    blockedUntil = Date.now() + COOLDOWN_MS;
    return undefined;
  }
  if (r.status === 404) { cache.set(handle, { v: null, ts: Date.now() }); return null; }
  if (!r.ok) return undefined;
  const j = await r.json().catch(() => null);
  const v = j?.data?.user?.edge_followed_by?.count;
  if (!Number.isInteger(v)) return undefined;
  cache.set(handle, { v, ts: Date.now() });
  return v;
}

// handles → { handle: followers }. Whatever couldn't be read is simply absent.
export async function lookupFollowers(handles, { isBusy = async () => false } = {}) {
  const list = [...new Set(handles.map(cleanHandle).filter(Boolean))].slice(0, MAX_PER_CALL);
  const results = {};
  if (!list.length) return { results };
  if (Date.now() < blockedUntil) return { results, error: "rate_limited" };
  if (await isBusy()) return { results, error: "busy" };

  let i = 0;
  const worker = async () => {
    while (i < list.length && Date.now() >= blockedUntil) {
      const h = list[i++];
      try {
        const v = await one(h);
        if (Number.isInteger(v)) results[h] = v;
      } catch (_) { /* network: stays without a number */ }
      await sleep(350 + Math.random() * 550);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { results, ...(Date.now() < blockedUntil ? { error: "rate_limited" } : {}) };
}
