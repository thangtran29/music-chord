'use strict';

const fs = require('fs');
const path = require('path');

const WORKER_PATH = path.join(__dirname, '..', '..', 'worker.js');

/**
 * Extracts the pure chord-matching/DSP logic straight out of worker.js so
 * tests run the shipped source, not a hand-copied version that can drift
 * out of sync (this is exactly how a stale copy of CHORD_TYPES cost real
 * debugging time before this file existed). Same "slice by string marker"
 * approach CLAUDE.md documents for index.html, applied to worker.js.
 *
 * Two slices are concatenated, with the self.exports/importScripts/
 * whenReady block excluded in between (browser-only, not Node-compatible):
 *   1. `const FRAME_SIZE = 4096;` ... up to (not including) `self.exports`
 *      - CHORD_TYPES, NOTE_NAMES, pcToBin, TEMPLATES, matchChord(), and the
 *        `let essentia / sampleRate / tuningHz` declarations the excluded
 *        block would otherwise wire up to the real WASM loader.
 *   2. `frameFeatures()` ... up to (not including) `self.onmessage`
 *      - frameFeatures(), median(), analyse(). These use the `essentia`
 *        variable from slice 1 - call setEssentia() before analyse().
 *
 * If worker.js is restructured, the indexOf() calls below throw instead of
 * silently slicing the wrong thing - update the markers to match.
 */
function loadWorkerDSP() {
  const src = fs.readFileSync(WORKER_PATH, 'utf8');

  const sliceAStart = src.indexOf('const FRAME_SIZE = 4096;');
  const sliceAEnd = src.indexOf('self.exports = {};');
  const sliceBStart = src.indexOf('/** One frame -> {chroma, pitch, conf, cents}');
  const sliceBEnd = src.indexOf('self.onmessage = function');

  for (const [name, idx] of [['sliceAStart', sliceAStart], ['sliceAEnd', sliceAEnd],
                              ['sliceBStart', sliceBStart], ['sliceBEnd', sliceBEnd]]) {
    if (idx === -1) throw new Error('load-worker-dsp: marker ' + name + ' not found - worker.js changed shape, update the markers');
  }

  const body = src.slice(sliceAStart, sliceAEnd) + src.slice(sliceBStart, sliceBEnd) + `
    function setEssentia(e) { essentia = e; }
    function setSampleRate(sr) { sampleRate = sr; }
    function resetTuning() { tuningHz = 440; }
    module.exports = {
      CHORD_TYPES, NOTE_NAMES, TEMPLATES, matchChord, analyse,
      setEssentia, setSampleRate, resetTuning
    };
  `;

  const mod = { exports: {} };
  new Function('module', body)(mod);
  return mod.exports;
}

module.exports = { loadWorkerDSP };
