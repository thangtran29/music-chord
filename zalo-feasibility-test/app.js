'use strict';

/**
 * Feasibility spike, round 6 - the real deal. Round 5 found why
 * fetch('./essentia-wasm.umd.js') 404d: assets are NOT served relative to
 * location.href. They live on a different domain (h5.zadn.vn vs the page's
 * h5.zdn.vn) under a per-deploy version path
 * (/zapps/{APP_ID}/{version}/essentia-wasm.umd.js), which only
 * document.currentScript.src reveals at runtime.
 *
 * This round: discover the real base URL from this very script's own src,
 * fetch essentia-wasm.umd.js from the analogous path, build a Blob worker
 * from the fetched text, and confirm EssentiaWASM actually compiles.
 */

// Capture this NOW - document.currentScript is only valid synchronously
// while this script is initially executing.
const OWN_SCRIPT_URL = document.currentScript && document.currentScript.src;

const root = document.createElement('div');
root.style.cssText = 'font-family:sans-serif;padding:16px;font-size:14px;line-height:1.6;word-break:break-all;';
root.innerHTML = `
  <h2>Zalo feasibility - round 6 (real deal)</h2>
  <button id="run" style="font-size:18px;padding:10px 20px;">Run test</button>
  <div id="base">own script URL: ${OWN_SCRIPT_URL || '(document.currentScript unavailable)'}</div>
  <div id="result">Real Essentia WASM: not tested</div>
`;
document.body.appendChild(root);

const resultEl = document.getElementById('result');

function pollScript() {
  return [
    '(function poll(start) {',
    '  start = start || Date.now();',
    '  var wasm = self.exports.EssentiaWASM;',
    '  if (wasm && typeof wasm.EssentiaJS === "function") {',
    '    self.postMessage({ ok: true, ms: Date.now() - start });',
    '    return;',
    '  }',
    '  if (Date.now() - start > 45000) {',
    '    self.postMessage({ ok: false, message: "compile timeout after 45s" });',
    '    return;',
    '  }',
    '  setTimeout(function () { poll(start); }, 50);',
    '})();'
  ].join('\n');
}

async function testRealEssentiaViaDiscoveredUrl() {
  if (!OWN_SCRIPT_URL) {
    resultEl.textContent = 'Real Essentia WASM: FAILED - document.currentScript.src unavailable, cannot derive base URL';
    return;
  }
  const wasmUrl = OWN_SCRIPT_URL.replace(/app\.js([^/]*)$/, 'essentia-wasm.umd.js$1');

  let text;
  try {
    resultEl.textContent = 'Real Essentia WASM: fetching ' + wasmUrl + ' ...';
    const res = await fetch(wasmUrl);
    if (!res.ok) {
      resultEl.textContent = 'Real Essentia WASM: FAILED - HTTP ' + res.status + ' at ' + wasmUrl;
      return;
    }
    text = await res.text();
  } catch (err) {
    resultEl.textContent = 'Real Essentia WASM: FAILED at fetch - ' + err.message;
    return;
  }

  resultEl.textContent = 'Real Essentia WASM: fetched ' + text.length + ' chars, compiling in a worker...';

  await new Promise((resolve) => {
    let worker;
    try {
      const blob = new Blob(['self.exports = {};\n' + text + '\n' + pollScript()], { type: 'application/javascript' });
      worker = new Worker(URL.createObjectURL(blob));
    } catch (err) {
      resultEl.textContent = 'Real Essentia WASM: FAILED to build worker (fetched ' + text.length + ' chars) - ' + err.message;
      resolve();
      return;
    }
    const t = setTimeout(() => {
      resultEl.textContent = 'Real Essentia WASM: FAILED - fetched OK but wasm never signalled ready within 50s';
      worker.terminate();
      resolve();
    }, 50000);
    worker.onmessage = function (e) {
      clearTimeout(t);
      resultEl.textContent = e.data.ok
        ? 'Real Essentia WASM: OK! fetched ' + text.length + ' chars, compiled in ' + e.data.ms + 'ms'
        : 'Real Essentia WASM: FAILED after fetch - ' + e.data.message;
      worker.terminate();
      resolve();
    };
    worker.onerror = function (e) {
      clearTimeout(t);
      resultEl.textContent = 'Real Essentia WASM: FAILED - worker onerror after successful fetch: ' + (e.message || 'unknown');
      resolve();
    };
  });
}

document.getElementById('run').addEventListener('click', testRealEssentiaViaDiscoveredUrl);
