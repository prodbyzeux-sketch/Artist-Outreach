// make-promo.mjs — the store's promo tiles, built from the app's own backdrop,
// mark and palette so the listing and the product look like one thing.
//
//   node test/make-promo.mjs
//
// Output: store/promo/small-440x280.png and store/promo/marquee-1400x560.png,
// 24-bit PNG, no alpha.

import fs from "node:fs";
import path from "node:path";
import { ROOT, PORT, serve, capture } from "./shot-lib.mjs";

const OUT_DIR = path.join(ROOT, "store", "promo");
const PAGE = path.join(ROOT, "store", "_promo.html");

const TILES = [
  { name: "small-440x280", w: 440, h: 280 },
  { name: "marquee-1400x560", w: 1400, h: 560 },
];

// The backdrop treatment is copied from app.css on purpose: at full brightness
// the sand is lighter than the text standing on it.
const HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; height: 100%; }
      body {
        background: #0b0b0c;
        color: #ededed;
        font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        overflow: hidden;
      }
      .bg, .veil { position: fixed; inset: 0; }
      .bg {
        background: url("../assets/backdrop.jpg") center / cover no-repeat;
        filter: brightness(0.46) saturate(0.7);
      }
      .veil { background: linear-gradient(180deg, rgba(11,11,12,0.46) 0%, rgba(11,11,12,0.78) 100%); }

      .tile {
        position: relative;
        height: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
      }
      .mark { display: block; width: auto; object-fit: contain; filter: invert(1); opacity: 0.94; }
      .name { font-weight: 500; letter-spacing: -0.02em; line-height: 1; }
      .tag { color: #b4b4ba; }
      .steps { color: #8a8a90; text-transform: uppercase; letter-spacing: 0.18em; }

      /* 440×280 — shown small in category lists, so: the mark, the name, one line. */
      .small .mark { height: 62px; margin-bottom: 16px; }
      .small .name { font-size: 44px; margin-bottom: 12px; }
      .small .tag { font-size: 14px; }

      /* 1400×560 — the featured strip, where there is room to breathe. */
      .marquee .mark { height: 124px; margin-bottom: 30px; }
      .marquee .name { font-size: 92px; margin-bottom: 22px; }
      .marquee .tag { font-size: 26px; margin-bottom: 34px; }
      .marquee .steps { font-size: 14px; }
    </style>
  </head>
  <body>
    <div class="bg"></div>
    <div class="veil"></div>
    <div class="tile" id="tile">
      <img class="mark" src="../assets/logo.png" alt="" />
      <div class="name">siluet</div>
      <div class="tag" id="tag"></div>
      <div class="steps" id="steps"></div>
    </div>
    <script>
      const kind = new URLSearchParams(location.hash.slice(1)).get("tile") || "small";
      document.getElementById("tile").classList.add(kind);
      document.getElementById("tag").textContent = kind === "marquee"
        ? "Instagram outreach from a lead table"
        : "Instagram DMs, from a spreadsheet";
      document.getElementById("steps").textContent = kind === "marquee"
        ? "import · personalise · send · measure"
        : "";
    </script>
  </body>
</html>
`;

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(PAGE, HTML);
  const server = await serve();
  try {
    for (const t of TILES) {
      const kind = t.name.startsWith("marquee") ? "marquee" : "small";
      await capture({
        url: `http://127.0.0.1:${PORT}/store/_promo.html#tile=${kind}`,
        out: path.join(OUT_DIR, `${t.name}.png`),
        w: t.w, h: t.h,
      });
      console.log(`${t.name}.png`);
    }
  } finally {
    server.close();
    fs.unlinkSync(PAGE);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
