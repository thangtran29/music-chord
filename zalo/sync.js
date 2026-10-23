#!/usr/bin/env node
'use strict';

/**
 * Builds zalo/app.js from the root index.html + worker.js - the same
 * single-source-of-truth approach as mobile/sync.js, adapted for Zalo Mini
 * App's very different hosting model (see the header comment generated
 * into app.js, and CLAUDE.md > "Zalo Mini App packaging" for the full
 * story of how this shape was derived from zalo-feasibility-test/).
 *
 * Unlike Capacitor, Zalo does not serve your index.html - it generates its
 * own wrapper with a #app root and only injects the JS/CSS you list in
 * app-config.json. So this script:
 *   1. Pulls the <style> and <body> content out of index.html and folds
 *      them into a script that builds the page at runtime.
 *   2. Pulls worker.js's DSP logic out (everything except its CDN/LOCAL
 *      loading preamble, which doesn't work here - Zalo serves assets from
 *      a different domain than the page, under a per-deploy version path
 *      only discoverable via document.currentScript.src at runtime).
 *   3. Patches the two lines in index.html's initWorker() that assume a
 *      synchronous `new Worker('worker.js')` - Zalo needs an async fetch
 *      of the Essentia files first, then a Blob worker built from them.
 *
 * Run this after any change to root index.html or worker.js, then
 * `zmp deploy` from this directory.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ZALO_DIR = __dirname;

function copy(from, to) {
  fs.copyFileSync(from, to);
  console.log('  ' + path.relative(ROOT, from) + ' -> ' + path.relative(ROOT, to));
}

async function ensureEssentiaFiles() {
  const files = ['essentia-wasm.umd.js', 'essentia.js-core.umd.js'];
  const cacheDir = path.join(ROOT, 'test', '.cache');
  const missing = files.filter((f) => !fs.existsSync(path.join(cacheDir, f)));
  if (missing.length) {
    console.log('Essentia files not cached yet - fetching via test/lib/essentia-node.js...');
    await require(path.join(ROOT, 'test', 'lib', 'essentia-node.js')).loadEssentia();
  }
  return files.map((f) => path.join(cacheDir, f));
}

/** worker.js minus its CDN/LOCAL importScripts preamble - see worker.js's
 * own comments for why that block exists; it's replaced by createWorker()
 * in the generated app.js, which fetches the same two files as text and
 * concatenates them instead. */
function extractWorkerBody() {
  const src = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
  const loadStart = src.indexOf('self.exports = {};');
  const loadEnd = src.indexOf('const INIT_TIMEOUT_MS');
  if (loadStart === -1 || loadEnd === -1) {
    throw new Error('zalo/sync.js: worker.js markers moved, update extractWorkerBody()');
  }
  return src.slice(0, loadStart) + src.slice(loadEnd);
}

function extractFromIndexHtml() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  const styleStart = html.indexOf('<style>') + '<style>'.length;
  const styleEnd = html.indexOf('</style>');
  if (styleStart === -1 || styleEnd === -1) throw new Error('zalo/sync.js: <style> markers not found in index.html');
  const css = html.slice(styleStart, styleEnd);

  // Search from styleEnd onward, not from the start of the file - a CSS
  // comment mentioning "<body>" or "<script>" (to talk about the actual
  // HTML tags) would otherwise get matched instead of the real markup,
  // silently slicing garbage into bodyHtml. This bit us once already.
  const bodyTagIdx = html.indexOf('<body>', styleEnd);
  if (bodyTagIdx === -1) throw new Error('zalo/sync.js: <body> marker not found after </style> in index.html');
  const bodyStart = bodyTagIdx + '<body>'.length;

  const scriptTagStart = html.indexOf('<script>', bodyStart);
  if (scriptTagStart === -1) throw new Error('zalo/sync.js: <script> marker not found after <body> in index.html');
  const bodyHtml = html.slice(bodyStart, scriptTagStart).trim();

  const scriptStart = scriptTagStart + '<script>'.length;
  const scriptEnd = html.lastIndexOf('</script>');
  let script = html.slice(scriptStart, scriptEnd);

  // The only two lines in the whole script that assume Capacitor/web's
  // synchronous `new Worker('worker.js')` - everything else (UI, analysis
  // loop, key detection) is unchanged.
  const OLD_FN = 'function initWorker() {';
  const NEW_FN = 'async function initWorker() {';
  const OLD_NEW_WORKER = "worker = new Worker('worker.js');";
  const NEW_NEW_WORKER = 'worker = await createWorker();';
  if (!script.includes(OLD_FN) || !script.includes(OLD_NEW_WORKER)) {
    throw new Error('zalo/sync.js: initWorker() shape changed in index.html, update the patch strings');
  }
  script = script.replace(OLD_FN, NEW_FN).replace(OLD_NEW_WORKER, NEW_NEW_WORKER);

  return { css, bodyHtml, script };
}

async function main() {
  const essentiaFiles = await ensureEssentiaFiles();
  for (const f of essentiaFiles) copy(f, path.join(ZALO_DIR, path.basename(f)));

  const workerBody = extractWorkerBody();
  const { css, bodyHtml, script } = extractFromIndexHtml();

  const appJs = `'use strict';
// GENERATED by zalo/sync.js from the root index.html + worker.js.
// Do not hand-edit - re-run "node sync.js" after changing either source file.

// document.currentScript is only valid synchronously while this script
// first runs, so capture it immediately.
const OWN_SCRIPT_URL = document.currentScript && document.currentScript.src;

const styleEl = document.createElement('style');
styleEl.textContent = ${JSON.stringify(css)};
document.head.appendChild(styleEl);

document.getElementById('app').innerHTML = ${JSON.stringify(bodyHtml)};

// --- Zalo-specific worker construction ---
// worker.js's own CDN/LOCAL importScripts() doesn't work here: Zalo serves
// assets from a different domain (h5.zadn.vn) than the page (h5.zdn.vn),
// under a per-deploy version path only discoverable via
// document.currentScript.src at runtime (see zalo-feasibility-test/ for
// how this was found, and CLAUDE.md > "Zalo Mini App packaging"). Fetch
// both Essentia files as text and concatenate them with worker.js's own
// logic (loading preamble stripped by sync.js) into one Blob worker.
const WORKER_BODY = ${JSON.stringify(workerBody)};

async function createWorker() {
  if (!OWN_SCRIPT_URL) throw new Error('document.currentScript.src unavailable - cannot locate Essentia assets');
  const base = OWN_SCRIPT_URL.replace(/app\\.js([^/]*)$/, '');
  const [wasmText, coreText] = await Promise.all([
    fetch(base + 'essentia-wasm.umd.js').then((r) => {
      if (!r.ok) throw new Error('essentia-wasm.umd.js HTTP ' + r.status);
      return r.text();
    }),
    fetch(base + 'essentia.js-core.umd.js').then((r) => {
      if (!r.ok) throw new Error('essentia.js-core.umd.js HTTP ' + r.status);
      return r.text();
    })
  ]);
  const src = 'self.exports = {};\\n' + wasmText + '\\n' + coreText + '\\n' + WORKER_BODY;
  const blob = new Blob([src], { type: 'application/javascript' });
  return new Worker(URL.createObjectURL(blob));
}

// --- app logic, lifted from index.html's <script> (initWorker patched to
// use createWorker() above - see zalo/sync.js) ---
${script}
`;

  fs.writeFileSync(path.join(ZALO_DIR, 'app.js'), appJs);
  console.log('Wrote zalo/app.js:', fs.statSync(path.join(ZALO_DIR, 'app.js')).size, 'bytes');
  console.log('Next: cd zalo && npx zmp-cli@4.0.3 deploy');
}

main().catch((err) => {
  console.error(err.stack || err);
  process.exitCode = 1;
});
