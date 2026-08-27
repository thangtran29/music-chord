#!/usr/bin/env node
'use strict';

/**
 * Copies the shared web source (root index.html + worker.js) plus the
 * offline Essentia.js bundle into mobile/www/, which is what Capacitor
 * packages into the native app. Run this before `npx cap sync`, and again
 * any time index.html or worker.js changes.
 *
 * index.html and worker.js are NOT edited during the copy - worker.js
 * already tries a local `./essentia-*.js` next to itself before falling
 * back to the CDN (see the LOCAL/CDN constants at the top of worker.js),
 * so the exact same file works unmodified in both the web deploy and here.
 *
 * The Essentia files are large (~2.9MB) and rarely change (pinned to
 * essentia.js@0.1.3 in worker.js's CDN constant) - reuses test/.cache/ if
 * already downloaded there, otherwise fetches them once.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WWW = path.join(__dirname, 'www');
const TEST_CACHE = path.join(ROOT, 'test', '.cache');

function copy(from, to) {
  fs.copyFileSync(from, to);
  console.log('  ' + path.relative(ROOT, from) + ' -> ' + path.relative(ROOT, to));
}

async function ensureEssentiaFiles() {
  const files = ['essentia-wasm.umd.js', 'essentia.js-core.umd.js'];
  const missing = files.filter((f) => !fs.existsSync(path.join(TEST_CACHE, f)));
  if (missing.length) {
    console.log('Essentia files not cached yet - fetching via test/lib/essentia-node.js...');
    // Reuses the exact same loader/cache the accuracy test uses, so there is
    // only one place that knows how to fetch and validate these files.
    await require(path.join(ROOT, 'test', 'lib', 'essentia-node.js')).loadEssentia();
  }
  return files.map((f) => path.join(TEST_CACHE, f));
}

async function main() {
  fs.mkdirSync(WWW, { recursive: true });

  console.log('Syncing web source into mobile/www/...');
  copy(path.join(ROOT, 'index.html'), path.join(WWW, 'index.html'));
  copy(path.join(ROOT, 'worker.js'), path.join(WWW, 'worker.js'));

  const essentiaFiles = await ensureEssentiaFiles();
  for (const f of essentiaFiles) copy(f, path.join(WWW, path.basename(f)));

  console.log('Done. Run `npx cap sync` next to push www/ into the native projects.');
}

main().catch((err) => {
  console.error(err.stack || err);
  process.exitCode = 1;
});
