'use strict';

/**
 * Loads Essentia.js for use in plain Node scripts - the same CDN build
 * worker.js uses in the browser, cached locally so repeat runs don't
 * re-download ~2.9MB. See CLAUDE.md > "Verifying changes" for why this is
 * the fastest way to sweep DSP parameters: no browser, no mic permission,
 * and it drives the exact wasm build the app ships.
 *
 * Node quirks (found the hard way while building this):
 *   - require()'ing essentia-wasm.umd.js returns the Emscripten Module
 *     object directly, NOT {EssentiaWASM: Module}. worker.js's
 *     `self.exports.EssentiaWASM = Module` trick is a browser-only
 *     workaround (a Worker has no `exports` global) - in Node,
 *     `module.exports` is reassigned by the file's own UMD boilerplate
 *     before that manual line ever runs.
 *   - require()'ing essentia.js-core.umd.js returns the Essentia class
 *     itself (its UMD wrapper does `module.exports = factory()`), not
 *     {Essentia: ...}.
 *   - The wasm module compiles asynchronously; poll for `wasm.EssentiaJS`
 *     becoming a function, same as worker.js's own whenReady().
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const CDN = 'https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/';
const CACHE_DIR = path.join(__dirname, '..', '.cache');
const FILES = ['essentia-wasm.umd.js', 'essentia.js-core.umd.js'];
const INIT_TIMEOUT_MS = 45000; // matches worker.js - a slow machine compiling the wasm

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        download(res.headers.location, destPath).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error('GET ' + url + ' -> HTTP ' + res.statusCode));
        return;
      }
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    }).on('error', reject);
  });
}

async function ensureCached() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  for (const name of FILES) {
    const dest = path.join(CACHE_DIR, name);
    if (!fs.existsSync(dest)) {
      process.stderr.write('Downloading ' + name + ' from jsDelivr...\n');
      await download(CDN + name, dest);
    }
  }
}

function whenReady(wasm) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function poll() {
      if (typeof wasm.EssentiaJS === 'function') return resolve();
      if (Date.now() - start > INIT_TIMEOUT_MS) return reject(new Error('Essentia wasm did not finish compiling'));
      setTimeout(poll, 20);
    })();
  });
}

/** Resolves to a ready `essentia` instance (real Essentia class, real wasm). */
async function loadEssentia() {
  await ensureCached();
  const wasm = require(path.join(CACHE_DIR, 'essentia-wasm.umd.js'));
  const Essentia = require(path.join(CACHE_DIR, 'essentia.js-core.umd.js'));
  await whenReady(wasm);
  return new Essentia(wasm);
}

module.exports = { loadEssentia, CACHE_DIR };
