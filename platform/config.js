// config.js — where the Artist Outreach web app lives.
//
// The extension only talks to these origins (and only injects bridge.js and
// allows embedding there). The copy users download from the app is patched
// with the app's own domain automatically (server/extensionPack.js); for a
// local checkout, change it with:
//
//   node platform/set-origin.mjs https://app.yourdomain.com
//
// which rewrites this list AND manifest.json together (they must match).

export const PLATFORM_ORIGINS = [
  "https://app.example.com",
  "http://localhost:3456",
];

// The first one is production: "Open Artist Outreach" goes there.
export const DEFAULT_ORIGIN = PLATFORM_ORIGINS[0];

export const isPlatformOrigin = (origin) => PLATFORM_ORIGINS.includes(String(origin || ""));
