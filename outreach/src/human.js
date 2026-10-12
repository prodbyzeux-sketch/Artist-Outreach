// human.js — one stable "personality" per browser profile, plus the mouse-path
// maths. No chrome APIs here: pure functions, so the numbers can be reasoned
// about (and unit-tested) on their own.
//
// HumanProfile is a port of Tabels' struct of the same name — identical field
// set and ranges, seeded from a string so the same profile always behaves the
// same way. (The seed hash differs from Swift's SHA-256 + SplitMix64, so the
// rolled values are not bit-identical to Tabels — they don't need to be, these
// are different accounts.)
//
// The trajectory is Tabels' swipe() curve — a quadratic Bézier whose control
// point is offset perpendicular to the line by (1 - mouseStraightness), walked
// with a smoothstep ease — plus the two ideas worth taking from ghost-cursor:
// duration from Fitts's law, and overshoot-then-correct on long moves.

// ── seeded randomness (personality only; per-action jitter uses Math.random) ──
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function makeProfile(seed) {
  const r = prng(hashString(String(seed)));
  const range = (lo, hi) => lo + r() * (hi - lo);
  const intIn = (lo, hi) => Math.floor(lo + r() * (hi - lo + 1));
  const holdLo = intIn(50, 90);
  return {
    typingWPM: range(35, 110),
    typoRate: range(0.025, 0.1),
    thinkPauseRate: range(0.04, 0.12),
    wordPauseMs: intIn(60, 220),
    sentencePauseMs: intIn(250, 700),
    tapJitterPx: range(2, 8),
    holdMs: [holdLo, holdLo + intIn(20, 80)], // mouse-down dwell
    mouseStraightness: range(0.55, 0.95),     // 1 = ruler-straight, 0 = chaotic
    preferredHourBias: intIn(8, 22),          // hour of peak alertness
    lookAroundChance: range(0.1, 0.2),
    scrollBackChance: range(0.1, 0.2),
  };
}

export const baseCharDelayMs = (p) => 60000 / (p.typingWPM * 5);

// ── pacing multipliers (bigger = slower) ─────────────────────────────────────
// Where we are in the session arc: warm-up, steady, then fatigue.
export function arcMultiplier(sentInSession) {
  if (sentInSession < 3) return 1.35;
  if (sentInSession <= 15) return 1.0;
  return Math.min(1.4, 1.1 + (sentInSession - 15) * 0.01);
}

export const typoMultiplier = (sentInSession) => (sentInSession <= 15 ? 1.0 : 1.2);

// Time of day: fastest around the profile's preferred hour, slowest at night.
export function dayPartMultiplier(profile, hour = new Date().getHours()) {
  const diff = Math.abs(hour - profile.preferredHourBias);
  const wrapped = Math.min(diff, 24 - diff);
  return 1 + 0.02 * wrapped + (hour <= 5 ? 0.15 : 0);
}

// ── mouse path ────────────────────────────────────────────────────────────────
const rand = (a, b) => a + Math.random() * (b - a);
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

// One Bézier sweep from → to. Returns points carrying their own delay, so the
// caller just walks the list.
function leg(from, to, profile, speedMult) {
  const d = dist(from, to);
  // Fitts's law: time grows with the log of the distance, not linearly.
  const duration = (90 + 130 * Math.log2(d / 30 + 1)) * speedMult * rand(0.85, 1.2);
  const steps = Math.max(6, Math.min(48, Math.round(duration / 16))); // ≈60 Hz, like a real move
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.max(1, d);
  const chaos = Math.max(4, d * (1 - profile.mouseStraightness) * 0.5);
  const side = Math.random() < 0.5 ? 1 : -1;
  const cx = from.x + dx * 0.5 + (-dy / len) * chaos * side; // control point sits
  const cy = from.y + dy * 0.5 + (dx / len) * chaos * side;  // perpendicular to the line

  const out = [];
  for (let i = 1; i <= steps; i++) {
    const raw = i / steps;
    const t = raw * raw * (3 - 2 * raw); // smoothstep: slow off the mark, slow onto it
    const u = 1 - t;
    out.push({
      x: u * u * from.x + 2 * u * t * cx + t * t * to.x,
      y: u * u * from.y + 2 * u * t * cy + t * t * to.y,
      dt: (duration / steps) * rand(0.7, 1.3),
    });
  }
  return out;
}

const OVERSHOOT_MIN_PX = 150;

export function mousePath(from, to, profile, speedMult = 1) {
  const d = dist(from, to);
  let path;
  if (d >= OVERSHOOT_MIN_PX && Math.random() < 0.45) {
    // A fast hand lands past the target and pulls back — the correction leg is
    // shorter and quicker than the approach.
    const radius = Math.min(28, d * 0.08);
    const angle = Math.atan2(to.y - from.y, to.x - from.x) + rand(-0.3, 0.3);
    const past = { x: to.x + Math.cos(angle) * radius, y: to.y + Math.sin(angle) * radius };
    path = [...leg(from, past, profile, speedMult), ...leg(past, to, profile, speedMult * 0.55)];
  } else {
    path = leg(from, to, profile, speedMult);
  }
  // The hand settles: one micro-correction, ending exactly on target.
  if (Math.random() < 0.5) {
    const j = profile.tapJitterPx;
    path.push({ x: to.x + rand(-j, j), y: to.y + rand(-j, j), dt: rand(20, 60) });
    path.push({ x: to.x, y: to.y, dt: rand(20, 60) });
  }
  return path;
}
