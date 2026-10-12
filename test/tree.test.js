import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Two projects were moved into subfolders to become one extension, and a moved
// tree fails in exactly one way: a path that no longer points at anything.
// Chrome reports those one at a time, at runtime, in three different places
// (manifest load, module import, a 404 inside a page). These two tests read the
// whole tree instead.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

// Only what Chrome actually loads. Test fixtures reference paths that a dev
// server serves, not the extension root, and they never ship.
const SKIP_DIRS = new Set(['node_modules', '.git', 'icons', 'assets', 'test', 'bridge']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
    } else if (/\.(js|mjs|html|css)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const rel = (file) => path.relative(ROOT, file);

test('every file the manifest names exists', () => {
  const named = [
    manifest.background.service_worker,
    ...manifest.content_scripts.flatMap((entry) => entry.js),
    ...Object.values(manifest.icons),
  ];
  const missing = named.filter((file) => !fs.existsSync(path.join(ROOT, file)));
  assert.deepEqual(missing, []);

  for (const entry of manifest.web_accessible_resources ?? []) {
    for (const pattern of entry.resources) {
      const dir = path.join(ROOT, path.dirname(pattern));
      assert.equal(fs.existsSync(dir), true, `${pattern}: ${path.relative(ROOT, dir)} is missing`);
      assert.equal(fs.readdirSync(dir).length > 0, true, `${pattern} matches nothing`);
    }
  }
});

test('no content script declares a name at the top level of a shared world', () => {
  // Before the merge each half had its own isolated world. Now every content
  // script of this extension shares ONE, and a name declared twice in it is a
  // SyntaxError that takes down the whole content layer — capture and sending
  // together. Both halves therefore wrap their files; this keeps it that way.
  const DECLARATION = /^(?:export\s+)?(?:const|let|var|class|(?:async\s+)?function)\s+([A-Za-z_$][\w$]*)/;
  const leaked = [];
  for (const file of manifest.content_scripts.flatMap((entry) => entry.js)) {
    for (const line of fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n')) {
      const declared = DECLARATION.exec(line);
      if (declared) leaked.push(`${file} → ${declared[1]}`);
    }
  }
  assert.deepEqual(leaked, [], 'wrap the file in an IIFE, or hang it off globalThis like the outreach layer does');
});

test('the re-injection list matches the manifest, path for path', () => {
  // background.js re-injects the content layer by hand when a page stops
  // answering, listing the same files the manifest does — from the EXTENSION
  // root. Those two lists drifting apart is silent: the recovery path just stops
  // recovering, and a lead fails with "content script not responding".
  const source = fs.readFileSync(path.join(ROOT, 'outreach/src/background.js'), 'utf8');
  const declared = /const CONTENT_SCRIPTS = \[([\s\S]*?)\]/.exec(source);
  assert.notEqual(declared, null, 'CONTENT_SCRIPTS is gone — this test needs rewriting');
  const injected = [...declared[1].matchAll(/["']([^"']+)["']/g)].map(([, file]) => file);

  const fromManifest = manifest.content_scripts
    .flatMap((entry) => entry.js)
    .filter((file) => file.startsWith('outreach/src/content/'));
  assert.deepEqual(injected, fromManifest);
});

test('every runtime.getURL points at a real file', () => {
  // Not covered by the relative-path test below: these are extension-ROOT
  // relative and carry no leading `./`. They are also the paths Chrome fails on
  // last and loudest — the toolbar icon opens a blank tab and says nothing about
  // why. Moving the CRM page under `page/` broke exactly this line.
  const broken = [];
  for (const file of walk(ROOT)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const [, target] of source.matchAll(/getURL\(\s*['"]([^'"$`]+)['"]\s*\)/g)) {
      if (!fs.existsSync(path.join(ROOT, target.replace(/^\//, '')))) broken.push(`${rel(file)} → ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});

test('every relative path inside the extension points at a real file', () => {
  // import/from "./x", <script src="x">, <link href="x">, url("x") in CSS.
  const PATTERNS = [
    /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g,
    /(?:src|href)\s*=\s*['"]([^'":#?][^'"]*)['"]/g,
    /url\(\s*['"]?([^'")]+)['"]?\s*\)/g,
  ];
  const external = (target) => /^(?:[a-z]+:|\/\/|#|data:)/i.test(target);
  // `url(${skin.file})` and friends: a path that is computed is not a path we
  // can check, and pretending otherwise would make this test cry wolf.
  const computed = (target) => /[${}`\s]/.test(target);

  const broken = [];
  for (const file of walk(ROOT)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const pattern of PATTERNS) {
      for (const [, target] of source.matchAll(pattern)) {
        if (external(target) || computed(target)) continue;
        const clean = target.split(/[?#]/)[0];
        if (!clean) continue;
        // A leading slash inside an extension means the extension root.
        const resolved = clean.startsWith('/')
          ? path.join(ROOT, clean)
          : path.resolve(path.dirname(file), clean);
        if (!fs.existsSync(resolved)) broken.push(`${rel(file)} → ${target}`);
      }
    }
  }
  assert.deepEqual(broken, []);
});
