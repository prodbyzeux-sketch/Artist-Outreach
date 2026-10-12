#!/usr/bin/env node
// Points a local checkout of the extension at the web app's domain, in every
// place that needs it: platform/config.js (who the extension talks to) and
// manifest.json (where bridge.js is injected, which host it may call, and who
// may embed the Outreach/Inbox pages). Usage:
//
//   node platform/set-origin.mjs https://app.yourdomain.com [http://localhost:3456]
//
// The first origin is production; localhost is kept for development.
// (The zip users download from the app is patched the same way by the server.)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (!args.length) {
  console.error("usage: node platform/set-origin.mjs https://app.yourdomain.com [more origins…]");
  process.exit(1);
}
const { patchConfig, patchManifest, normalizeOrigins } = require("../../server/extensionPack.js");
const origins = normalizeOrigins(args);

const cfgPath = path.join(ROOT, "platform", "config.js");
fs.writeFileSync(cfgPath, patchConfig(fs.readFileSync(cfgPath, "utf8"), origins));
const manPath = path.join(ROOT, "manifest.json");
fs.writeFileSync(manPath, patchManifest(fs.readFileSync(manPath, "utf8"), origins));
console.log("platform origins:", origins.join(", "));
