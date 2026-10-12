// audience.js — who is worth writing to, from the two numbers a profile shows.
//
// The numbers are READ OFF THE LEAD'S PROFILE, never asked for. Measured on live
// Instagram: Direct's own account search (`ranked_recipients`) carries username,
// full_name, is_private and the friendship flags but no counts at all, and the
// web app itself never calls the endpoint that would have them — so an extension
// calling it is making a request no ordinary browsing produces. Visiting the
// profile is the opposite: looking someone up before writing to them is the most
// human step in this whole flow, and the numbers are already in the page.
//
// The cost is honest — a filtered lead has had their conversation opened and
// their profile looked at — and it buys the thing that matters: no message went
// out, and nothing left a trace a person wouldn't leave.
//
// A filter with no bound set counts as no filter, so a switch left on with
// nothing but zeroes never sends the run walking to a profile for nothing.
//
// Pure — no chrome APIs, no DOM. The content script reads the page and asks this
// for the verdict, so every rule below is a node test rather than a run against
// live Instagram.

// The bounds, and the count each one is about. Everything below reads the
// settings through this, so the keys are named in one place.
//
// Posts are a floor and nothing else: the question they answer is whether an
// account posts at all, and posting a lot has never been a reason to skip
// someone. The zero in their max slot is the same "no bound" every other zero
// here means — including for the stored `maxPosts` of anyone who set one back
// when this was a range, which is now read by nobody.
const rangesOf = (s) => [
  [s.minFollowers || 0, s.maxFollowers || 0, "followers"],
  [s.minPosts || 0, 0, "posts"],
];

// 0 means "no bound" throughout, the same as maxPerRun and followupMaxPerRun.
export const audienceFilterOn = (settings) =>
  !!settings.audienceFilter && rangesOf(settings).some(([min, max]) => min > 0 || max > 0);

// Bounds nobody could satisfy. Left alone they would send the whole queue to
// `skipped` in one run, which looks exactly like a list that turned out to be
// worthless — so Start refuses instead, and says which pair is inside out.
export function audienceFilterProblem(settings) {
  if (!audienceFilterOn(settings)) return null;
  for (const [min, max, noun] of rangesOf(settings)) {
    if (min > 0 && max > 0 && min > max) {
      return `The ${noun} filter asks for at least ${formatCount(min)} and at most `
        + `${formatCount(max)} — no lead can match that`;
    }
  }
  return null;
}

const outside = (value, noun, bound) =>
  ({ pass: false, reason: `${formatCount(value)} ${noun} — ${bound}` });

// The reason lands in the lead's note, so it carries the number that failed and
// the bound it broke. "Outside the filter" on its own is a verdict nobody can
// argue with, which is the wrong kind of unarguable.
export function audienceVerdict(counts, settings) {
  for (const [min, max, noun] of rangesOf(settings)) {
    const value = counts[noun];
    if (min > 0 && value < min) return outside(value, noun, `under the ${formatCount(min)} minimum`);
    if (max > 0 && value > max) return outside(value, noun, `over the ${formatCount(max)} maximum`);
  }
  return { pass: true };
}

// A number the profile did not give up. Not a pass: a filter that waves through
// everyone it could not measure is worse than no filter, because it goes on
// claiming in Settings to be doing something. It is not a skip either — the lead
// is blameless — so it fails, and the run's own "three failures in a row" rule
// stops things if Instagram has moved the numbers out of reach for good.
// Which number is missing is the diagnosis: one of them gone is a word
// Instagram renamed, both gone is a header that never finished arriving.
const COUNT_NAMES = { followers: "follower", posts: "post" };

export function unreadableCounts(counts) {
  const missing = Object.keys(COUNT_NAMES).filter((key) => !Number.isFinite(counts[key]));
  if (!missing.length) return null;
  const named = missing.map((key) => COUNT_NAMES[key]).join(" and ");
  return `couldn't read their ${named} count${missing.length > 1 ? "s" : ""} on the profile`;
}

// A count as it reads inside a one-line note. 999_999 rounds to "1000k", which
// reads like a bug, so it is promoted to the next unit instead.
export function formatCount(n) {
  if (!Number.isFinite(n)) return "?";
  if (n < 1000) return String(n);
  const millions = n >= 999_500;
  const value = n / (millions ? 1e6 : 1000);
  const shown = value < 100 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${shown}${millions ? "M" : "k"}`;
}
