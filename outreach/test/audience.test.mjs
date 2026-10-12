// The audience filter: who is worth writing to, decided from two numbers.
// Pure functions, so this needs no browser and no stubs.
//
//   node test/audience.test.mjs
import {
  audienceFilterOn, audienceFilterProblem, unreadableCounts, audienceVerdict, formatCount,
} from "../src/audience.js";

const results = [];
const check = (name, pass, extra = "") =>
  results.push(`${pass ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);

const OFF = { audienceFilter: false, minFollowers: 0, maxFollowers: 0, minPosts: 0 };
const on = (over) => ({ ...OFF, audienceFilter: true, ...over });

// ── is the filter actually asking for anything? ───────────────────────────────
// A switch that is on with no bounds set would cost a request per lead and turn
// nobody away, which is worse than being off.
check("off is off", audienceFilterOn(OFF) === false);
check("on with no bounds is still off", audienceFilterOn(on({})) === false);
check("one bound is enough to be on", audienceFilterOn(on({ minFollowers: 500 })) === true);
check("the post floor alone is enough too", audienceFilterOn(on({ minPosts: 10 })) === true);
check("a bound without the switch stays off", audienceFilterOn({ ...OFF, minPosts: 10 }) === false);
// The post ceiling is gone from the form, but it is still sitting in the stored
// settings of anyone who set one, so every rule below has to ignore it outright.
check("a leftover post ceiling is not a bound", audienceFilterOn(on({ maxPosts: 500 })) === false);

// ── bounds nobody could satisfy ───────────────────────────────────────────────
check("sane bounds have no problem", audienceFilterProblem(on({ minFollowers: 500, maxFollowers: 5000 })) === null);
check("min above max is caught", !!audienceFilterProblem(on({ minFollowers: 5000, maxFollowers: 500 })));
check("  and it names the numbers",
  /5k/.test(audienceFilterProblem(on({ minFollowers: 5000, maxFollowers: 500 })) || ""));
check("a post floor alone can never be inside out", audienceFilterProblem(on({ minPosts: 40 })) === null);
check("  not even against a leftover ceiling under it",
  audienceFilterProblem(on({ minPosts: 40, maxPosts: 10 })) === null);
check("an off filter has no problem to report", audienceFilterProblem(OFF) === null);

// ── the verdict ───────────────────────────────────────────────────────────────
const verdict = (counts, over) => audienceVerdict(counts, on(over));

check("inside both bounds passes",
  verdict({ followers: 4000, posts: 30 }, { minFollowers: 1000, maxFollowers: 10000, minPosts: 5 }).pass === true);
check("0 as a bound is no bound at all",
  verdict({ followers: 4_000_000, posts: 0 }, { minFollowers: 0, maxFollowers: 0 }).pass === true);
check("too few followers fails", verdict({ followers: 200, posts: 30 }, { minFollowers: 1000 }).pass === false);
check("too many followers fails", verdict({ followers: 340000, posts: 30 }, { maxFollowers: 100000 }).pass === false);
check("too few posts fails", verdict({ followers: 4000, posts: 3 }, { minPosts: 10 }).pass === false);
check("posts have a floor and no ceiling",
  verdict({ followers: 4000, posts: 9000 }, { minPosts: 10 }).pass === true);
check("  and a leftover ceiling turns nobody away",
  verdict({ followers: 4000, posts: 900 }, { minPosts: 10, maxPosts: 500 }).pass === true);
check("a bound is inclusive at both ends",
  verdict({ followers: 1000, posts: 10 }, { minFollowers: 1000, maxFollowers: 1000, minPosts: 10 }).pass === true);

// The reason is what lands in the lead's note, so it has to carry the number it
// failed on AND the bound it broke — "outside the filter" alone is unarguable.
const reason = (counts, over) => verdict(counts, over).reason || "";
check("the reason names the count and the bound",
  /1\.2k followers/.test(reason({ followers: 1200, posts: 9 }, { minFollowers: 5000 }))
  && /5k minimum/.test(reason({ followers: 1200, posts: 9 }, { minFollowers: 5000 })),
  reason({ followers: 1200, posts: 9 }, { minFollowers: 5000 }));
check("  and says which way it broke",
  /over the/.test(reason({ followers: 340000, posts: 9 }, { maxFollowers: 100000 })),
  reason({ followers: 340000, posts: 9 }, { maxFollowers: 100000 }));
check("followers are reported before posts when both fail",
  /followers/.test(reason({ followers: 10, posts: 10 }, { minFollowers: 100, minPosts: 100 })));

// ── a number the profile didn't give up ───────────────────────────────────────
// Never a pass: a filter that waves through everyone it couldn't measure goes on
// claiming in Settings to be doing something. Not a skip either — the lead did
// nothing wrong — so it fails, and three in a row stop the run.
check("both numbers read means no problem", unreadableCounts({ followers: 1200, posts: 9 }) === null);
check("zero is a number, not a missing one", unreadableCounts({ followers: 0, posts: 0 }) === null);
check("a missing follower count is a problem", !!unreadableCounts({ followers: undefined, posts: 9 }));
check("a missing post count is a problem", !!unreadableCounts({ followers: 1200, posts: undefined }));
check("NaN is not a number either", !!unreadableCounts({ followers: NaN, posts: 9 }));
check("  and it says what it couldn't read",
  /follower and post counts/.test(unreadableCounts({ followers: undefined, posts: undefined })));
// Which one is missing is the whole diagnosis when this starts happening: one
// number gone is a word Instagram renamed, both gone is a header that never
// arrived. "Couldn't read them" tells nobody which.
check("  one number missing names that one alone",
  /their follower count on/.test(unreadableCounts({ followers: undefined, posts: 9 })),
  unreadableCounts({ followers: undefined, posts: 9 }));
check("  …either one",
  /their post count on/.test(unreadableCounts({ followers: 1200, posts: undefined })),
  unreadableCounts({ followers: 1200, posts: undefined }));

// ── how a count reads in a one-line note ──────────────────────────────────────
check("small numbers are themselves", formatCount(0) === "0" && formatCount(999) === "999");
check("thousands", formatCount(1200) === "1.2k" && formatCount(18400) === "18.4k");
check("no pointless decimal", formatCount(12000) === "12k" && formatCount(340000) === "340k");
check("millions", formatCount(1234567) === "1.2M");
check("999_999 does not read as 1000k", formatCount(999999) === "1M", formatCount(999999));
check("a missing number is not a zero", formatCount(undefined) === "?");

// ── report ────────────────────────────────────────────────────────────────────
console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
