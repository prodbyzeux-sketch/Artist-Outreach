// make-shots.mjs — the Chrome Web Store screenshots, taken from the real UI.
//
// Generates src/_shots.html (app.html + the demo seed + a scroll bootstrap) and
// drives headless Chrome once per shot. Output: store/screenshots/*.png,
// 1280×800, no alpha — what the dashboard's upload field asks for.
//
//   node test/make-shots.mjs             # write the screenshots
//   node test/make-shots.mjs --measure   # dump section geometry and stop

import fs from "node:fs";
import path from "node:path";
import { ROOT, PORT, CHROME, serve, run, chromeFlags, capture } from "./shot-lib.mjs";

const OUT_DIR = path.join(ROOT, "store", "screenshots");
const HARNESS = path.join(ROOT, "src", "_shots.html");
const W = 1280, H = 800;

// The run bar is fixed and 179px tall, so a shot shows ~620px of content and
// whatever falls under the bar is blurred rather than cut. Anchors are chosen so
// the point of each shot sits above that line.
const SHOTS = [
  { name: "1-leads", anchor: "body", offset: 0, openPreview: true },
  { name: "2-messages", anchor: "#sec-messages", offset: -26 },
  { name: "3-queue", anchor: ".queue", offset: -14, openPreview: true },
  { name: "4-dashboard", anchor: "#sec-dashboard", offset: -26 },
  { name: "5-followups", anchor: "#sec-followups", offset: -26 },
  { name: "6-settings", anchor: "#sec-settings", offset: -26 },
  { name: "7-activity", anchor: "#openerRates", offset: -50 },
];

// ── the harness ───────────────────────────────────────────────────────────────
const BOOTSTRAP = `
<script>
(() => {
  const params = new URLSearchParams(location.hash.slice(1));
  const ready = () => document.querySelectorAll("#leadList .lead").length
    && document.querySelectorAll("#messageList textarea").length
    && document.querySelectorAll("#openerRates .rate").length
    && document.querySelectorAll(".grid-col").length;

  const tick = () => {
    if (!ready()) return setTimeout(tick, 30);
    window.__fire({ type: "PROGRESS", state: window.__demo.runState });
    window.__demo.log.forEach((l) => window.__fire({ type: "LOG", text: l.text, level: l.level }));
    if (params.get("preview") === "1") document.querySelectorAll(".preview-wrap").forEach((p) => { p.open = true; });

    requestAnimationFrame(() => {
      const SEL = "main > details, #activityBlock, .preview-wrap, .or-line, .queue, "
        + ".queue-bar, #followupMonitor, .queue-head, #leadList, #whoCard, .stats, "
        + "#openerRates, #pathBlock, #hourChart, .runbar";
      const geo = {};
      for (const s of document.querySelectorAll(SEL)) {
        const r = s.getBoundingClientRect();
        geo[s.id || s.className.split(" ")[0]] = Math.round(r.top + window.scrollY) + "+" + Math.round(r.height);
      }
      geo.page = document.body.scrollHeight;
      // The vendored font is what the shots are typeset in — if it fails to
      // load, every store asset silently ships in the system stack instead.
      geo.inter = document.fonts.check("700 21px Inter");
      const box = document.createElement("div");
      box.id = "measure";
      box.style.display = "none";
      box.textContent = JSON.stringify(geo);
      document.body.append(box);

      // Not window.scrollTo: headless captures the page background and nothing
      // else once a shot scrolls more than a screen down. Sliding the content
      // instead leaves the fixed backdrop and run bar exactly where a scrolled
      // viewport would put them, and never touches the scroll offset.
      const anchor = params.get("anchor");
      if (anchor) {
        const el = document.querySelector(anchor);
        const y = el ? el.getBoundingClientRect().top + window.scrollY + Number(params.get("offset") || 0) : 0;
        const shift = \`translateY(\${-Math.max(0, y)}px)\`;
        document.getElementById("logo").style.transform = shift;
        document.querySelector("main").style.transform = shift;
      }
    });
  };
  tick();
})();
</script>`;

// The sections the shots anchor on. They carry these ids in the shipped markup
// now — src/ui/sections.js folds them by id — so the harness only checks that
// the ones it aims at are still there.
const SECTION_IDS = ["sec-leads", "sec-messages", "sec-followups", "sec-settings", "sec-dashboard"];

function buildHarness() {
  let html = fs.readFileSync(path.join(ROOT, "src", "app.html"), "utf8");

  const missing = SECTION_IDS.filter((id) => !html.includes(`id="${id}"`));
  if (missing.length) throw new Error(`app.html is missing section ids: ${missing.join(", ")}`);

  html = html.replace(/(<div class="dash-block">\s*<div class="dash-head">\s*<h3>Activity<\/h3>)/,
    (m) => m.replace('<div class="dash-block">', '<div class="dash-block" id="activityBlock">'));
  if (!html.includes('id="activityBlock"')) throw new Error("could not tag the Activity block");

  html = html.replace("</head>", `    <script src="../test/shots-seed.js"></script>\n  </head>`);
  html = html.replace("</body>", `${BOOTSTRAP}\n  </body>`);
  fs.writeFileSync(HARNESS, html);
}

const url = (shot) => {
  const q = new URLSearchParams({ anchor: shot.anchor, offset: String(shot.offset) });
  if (shot.openPreview) q.set("preview", "1");
  return `http://127.0.0.1:${PORT}/src/_shots.html#${q}`;
};

async function main() {
  buildHarness();
  const server = await serve();
  try {
    if (process.argv.includes("--measure")) {
      const dom = await run(CHROME, [...chromeFlags(W, H), "--dump-dom", url(SHOTS[0])]);
      const m = dom.match(/<div id="measure"[^>]*>(.*?)<\/div>/);
      console.log(m ? JSON.parse(m[1]) : "no #measure element — the app did not finish rendering");
      return;
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const shot of SHOTS) {
      await capture({ url: url(shot), out: path.join(OUT_DIR, `${shot.name}.png`), w: W, h: H });
      console.log(`${shot.name}.png`);
    }
  } finally {
    server.close();
    fs.unlinkSync(HARNESS);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
