// shot-lib.mjs — the shared half of the store-asset scripts: a static server
// (ES modules will not load over file://), the Chrome invocation with the flags
// that took a round of debugging to find, and the 2×-to-final downscale.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const PORT = 8731;

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2" };

export function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0].split("#")[0]).replace(/^\/+/, "");
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

export const run = (cmd, args) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d) => { out += d; });
  p.stderr.on("data", (d) => { out += d; });
  p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}\n${out}`))));
});

export const chromeFlags = (w, h) => [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
  "--force-device-scale-factor=2", `--window-size=${w},${h}`, "--virtual-time-budget=20000",
];

// Render at 2× and take it down to size — the difference between readable 13px
// text and mush. The flatten is not cosmetic: the store rejects a PNG that
// carries an alpha channel.
export async function capture({ url, out, w, h }) {
  const raw = `${out}.raw.png`;
  await run(CHROME, [...chromeFlags(w, h), `--screenshot=${raw}`, url]);
  await run("magick", [raw, "-resize", `${w}x${h}!`, "-background", "#0b0b0c",
    "-alpha", "remove", "-alpha", "off", "-strip", out]);
  fs.unlinkSync(raw);
}
