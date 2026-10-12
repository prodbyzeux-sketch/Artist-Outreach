// Keeping the picture, not the link to it.
//
// Instagram hands out `profile_pic_url` as a SIGNED CDN url: the path names the
// image and the query signs it, and the signature dies in a few days. Stored as
// a url, an avatar therefore works for a while and then every row in the list is
// a grey letter again — with no way back until Instagram happens to serve that
// thread in an inbox response.
//
// So the bytes are kept instead, and the path is what says WHICH picture they
// are: the signature changes on every re-issue and the host changes with
// whichever CDN edge answered, while the filename stays put. Comparing whole
// urls would refetch everything constantly and still miss a real change.
//
// Pure: the fetching and the scaling live in the service worker, the rules live
// here where they can be read and tested.

/** Displayed at 36 CSS px, so 72 covers a 2× screen and nothing more. */
export const AVATAR_PX = 72;

/** A profile picture is a few KB. An order of magnitude past that is not one. */
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

/** Per pass, so a first capture of 300 threads doesn't open 300 requests. */
export const FETCH_BATCH = 12;

/** Long enough that a failed signature has been reissued by the time we retry. */
export const RETRY_AFTER_MS = 6 * 3600000;

/** Where one lead's kept picture lives inside the `avatars` object. */
export const AVATARS_KEY = 'avatars';

/**
 * Which picture this url points at, independent of who signed it and which edge
 * served it. '' when the url is not a picture we can keep.
 */
export function pictureID(url) {
  if (typeof url !== 'string') return '';
  let parsed;
  try { parsed = new URL(url); } catch { return ''; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
  const file = parsed.pathname.split('/').pop() ?? '';
  return file.replace(/\.[a-z0-9]+$/i, '');
}

/**
 * The pictures worth fetching right now: missing, changed, or failed long enough
 * ago to be worth another go. Newest conversations first — those are the rows
 * the operator is looking at.
 */
export function staleAvatars(rows, cached = {}, { limit = FETCH_BATCH, now = Date.now() } = {}) {
  const wanted = new Map();
  const ordered = [...(rows ?? [])].sort((a, b) => (b?.lastActivityAt ?? 0) - (a?.lastActivityAt ?? 0));

  for (const row of ordered) {
    const igUserID = String(row?.igUserID ?? '');
    if (!igUserID || wanted.has(igUserID)) continue;
    const id = pictureID(row?.avatarURL);
    if (!id) continue;

    const have = cached[igUserID];
    if (have?.id === id) {
      if (have.data) continue;
      if (have.failedAt && now - have.failedAt < RETRY_AFTER_MS) continue;
    }
    wanted.set(igUserID, { igUserID, id, url: row.avatarURL });
    if (wanted.size >= limit) break;
  }
  return [...wanted.values()];
}
