'use strict';

/**
 * All DSP runs here, off the main thread, so the UI never blocks.
 * On a phone a single analysis pass can cost 100-250ms - run that on the main
 * thread and buttons and animations visibly stutter.
 *
 * This uses the .umd build rather than .web:
 *   - .web.js hardcodes ENVIRONMENT_IS_WORKER=false, so it cannot run in a worker
 *   - .umd.js embeds the wasm as a data URI, so there is no .wasm path to resolve
 *   - but .umd.js ends with `exports.EssentiaWASM = Module` (CommonJS), so
 *     `exports` has to exist before importScripts or it throws
 *     "exports is not defined"
 */

const CDN = 'https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/';
// Resolves against worker.js's own URL. Present only in app-store builds
// (Capacitor bundles these two files alongside worker.js for offline use -
// see mobile/README.md); absent on the plain web deploy, which ships only
// index.html + worker.js per CLAUDE.md and always falls through to the CDN.
const LOCAL = './';

const FRAME_SIZE = 4096;

// This range covers nearly the whole piano. Measured: widening from 60-2000 to
// 30-4200 took piano from 9/15 to 12/15 correct notes (recovering A1, C7, E7)
// while guitar stayed unchanged at 8/8. A0/C1 (27-33Hz) are still out of reach:
// a 4096-sample window holds only ~2 cycles there, which YIN cannot work with.
// It returns low confidence, so we show "no clear pitch" instead of guessing.
const PITCH_MIN_HZ = 30;
const PITCH_MAX_HZ = 4200;
const PITCH_CONF_MIN = 0.6;

// =====================================================================
//  Chord templates
//
//  Essentia's own ChordsDetection only knows 24 chords - major and minor. Real
//  songs are full of sevenths, and it does not just simplify them, it gets the
//  root wrong: measured, Am7 came out as C and Dm7 as F, both at "100%".
//
//  So: match the 12-bin HPCP against templates directly. Measured against the
//  old path - triads 24/24 (no regression), inversions and wide voicings 8/8,
//  and still 6/6 with pink noise as loud as the music (0 dB SNR).
//
//  L2-normalising each template is what makes this work without any tuning: a
//  3-note template wins when only 3 notes sound, and a 4-note template wins once
//  the seventh is actually there. That alone fixes the Am7-reads-as-C class of
//  error.
// =====================================================================
const CHORD_TYPES = [
  // prior mostly breaks ties between templates that score IDENTICALLY, but
  // 7/m7/maj7 below use it to correct for real, measured weaknesses in their
  // extra tone's HPCP signal at the top of the register - see their notes.
  { suffix: '',      iv: [0, 4, 7],      prior: 1.00 },
  { suffix: 'm',     iv: [0, 3, 7],      prior: 1.00 },
  // 1.00, not 0.97: the 0.97 penalty was untied from any measurement (see
  // note above) and, combined with the m7 tone's own weakening at the top of
  // the register (down to ~40% of the root's bin, same register effect as
  // maj7 below), was enough to flip B7/Bm7 to a bare triad in every trial.
  // A pure triad's cosine similarity already loses to the matching 7th
  // template whenever real energy sits in the 7th bin - equal priors do not
  // introduce false 7ths on their own, they just stop penalising real ones.
  // Measured: 0.97 -> B7/Bm7 0/10 each; 1.00 -> 0 failures anywhere in a
  // 12-root x 10-type sweep, noise robustness unchanged. 1.02+ overshoots
  // and starts misreading dim triads as dominant 7ths.
  { suffix: '7',     iv: [0, 4, 7, 10],  prior: 1.00 },
  { suffix: 'm7',    iv: [0, 3, 7, 10],  prior: 1.00 },
  // 1.05, not 0.95: the major 7th tone gets no reinforcement from the other
  // three chord tones' own low harmonics the way the root/3rd/5th reinforce
  // each other (their intervals are close to low-order harmonic ratios; a
  // major 7th is not). Its HPCP bin comes in weak - as low as 0.16 relative
  // to the root at higher registers (measured: root G and up read as a bare
  // triad, missing the 7th entirely, in ~every trial). A prior above 1.00
  // compensates for that structurally weak signal. Measured over a 12-root x
  // 10-type sawtooth sweep: 0.95 -> maj7 60/72 correct (all failures G and
  // above); 1.05 -> maj7 72/72, with zero new false positives on any other
  // chord type. Above ~1.15 the correction overshoots and other chords start
  // reading as maj7.
  { suffix: 'maj7',  iv: [0, 4, 7, 11],  prior: 1.05 },
  { suffix: 'sus4',  iv: [0, 5, 7],      prior: 0.93 },
  { suffix: 'dim',   iv: [0, 3, 6],      prior: 0.88 },
  { suffix: 'm7b5',  iv: [0, 3, 6, 10],  prior: 0.87 },
  { suffix: 'aug',   iv: [0, 4, 8],      prior: 0.85 },
  // 0.90, not 0.82: same register effect as '7'/'m7'/'maj7' above - dim7's
  // 4th tone (a diminished 7th, i.e. a major 6th above the root) comes in
  // weaker at the top of the register (down to ~0.64 relative to the root
  // for a B-rooted voicing) and 0.82 was too big a penalty to survive that,
  // losing to the plain "dim" triad. Measured over a 12-root x 10-type
  // sweep: 0.82 -> B(dim7) 0/8; 0.85 through 1.00 -> 0 failures anywhere
  // and 0 new false positives; 1.05 overshoots and starts misreading plain
  // dim triads as dim7. 0.90 sits in the middle of that safe range.
  { suffix: 'dim7',  iv: [0, 3, 6, 9],   prior: 0.90 }
  // '6', 'm6' and 'sus2' are deliberately absent: their pitch-class sets are
  // IDENTICAL to m7, m7b5 and sus4 respectively (C6 = Am7, Am6 = F#m7b5,
  // Csus2 = Gsus4). A 12-bin chroma folds away every octave, so nothing but the
  // bass note could tell them apart, and we do not have it. Keeping both members
  // of a pair would just be a coin flip, so the more common name wins and a C6
  // is reported as Am7 - the same notes, and the likelier reading.
];
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// HPCP bin 0 is A, but pitch class 0 is C, and A is pitch class 9
const pcToBin = function (pc) { return ((pc - 9) + 12) % 12; };

const TEMPLATES = [];
for (let root = 0; root < 12; root++) {
  for (let t = 0; t < CHORD_TYPES.length; t++) {
    const type = CHORD_TYPES[t];
    const vec = new Float32Array(12);
    for (let i = 0; i < type.iv.length; i++) vec[pcToBin((root + type.iv[i]) % 12)] = 1;
    let n = 0;
    for (let i = 0; i < 12; i++) n += vec[i] * vec[i];
    n = Math.sqrt(n);
    for (let i = 0; i < 12; i++) vec[i] /= n;
    TEMPLATES.push({ name: NOTE_NAMES[root] + type.suffix, vec: vec, prior: type.prior });
  }
}

/** Best-matching chord for one chroma frame, by cosine similarity. */
function matchChord(chroma) {
  let norm = 0;
  for (let i = 0; i < 12; i++) norm += chroma[i] * chroma[i];
  norm = Math.sqrt(norm);
  if (norm < 1e-9) return null;
  let best = null, bestScore = -1;
  for (let t = 0; t < TEMPLATES.length; t++) {
    const tpl = TEMPLATES[t];
    let d = 0;
    for (let i = 0; i < 12; i++) d += chroma[i] * tpl.vec[i];
    d = d / norm * tpl.prior;
    if (d > bestScore) { bestScore = d; best = tpl; }
  }
  return { chord: best.name, score: bestScore };
}

let essentia = null;
let sampleRate = 48000;
// Detected tuning of the source, fed back into HPCP on the next pass. Recordings
// are not always at A=440 (old transfers, A=432 releases, a guitar tuned by ear),
// and a wrong reference smears every chroma bin.
let tuningHz = 440;

self.exports = {};   // required, see the note above

try {
  try {
    // Bundled copy first - offline-capable and avoids a WebView's default
    // CSP blocking a cross-origin importScripts() to the CDN host.
    importScripts(LOCAL + 'essentia-wasm.umd.js');
    importScripts(LOCAL + 'essentia.js-core.umd.js');
  } catch (localErr) {
    importScripts(CDN + 'essentia-wasm.umd.js');
    importScripts(CDN + 'essentia.js-core.umd.js');
  }
} catch (err) {
  self.postMessage({ type: 'error', message: 'Failed to load Essentia.js: ' + err.message });
}

const INIT_TIMEOUT_MS = 45000;   // a phone decoding + compiling a 2MB wasm module
                                 // can take many seconds; 8s used to time out on mobile
function whenReady(cb, tries) {
  tries = tries || 0;
  const wasm = self.exports.EssentiaWASM;
  if (wasm && typeof wasm.EssentiaJS === 'function' && typeof self.Essentia === 'function') return cb(wasm);
  if (tries * 20 > INIT_TIMEOUT_MS) {
    // Say which half failed, so a slow phone is not confused with a broken load
    const loaded = !!wasm;
    self.postMessage({ type: 'error', message: loaded
      ? 'Essentia.js loaded but the WebAssembly module never finished compiling (waited ' +
        (INIT_TIMEOUT_MS / 1000) + 's). The device may be out of memory.'
      : 'Essentia.js did not load from the CDN within ' + (INIT_TIMEOUT_MS / 1000) +
        's. Check the network connection.' });
    return;
  }
  setTimeout(function () { whenReady(cb, tries + 1); }, 20);
}

whenReady(function (wasm) {
  try {
    essentia = new self.Essentia(wasm);
    self.postMessage({ type: 'ready', version: essentia.version });
  } catch (err) {
    self.postMessage({ type: 'error', message: 'Essentia initialization failed: ' + err.message });
  }
});

/** One frame -> {chroma, pitch, conf, cents}. Spectrum is computed once and shared. */
function frameFeatures(frame) {
  const frameVec = essentia.arrayToVector(frame);
  const windowed = essentia.Windowing(frameVec, true, FRAME_SIZE, 'blackmanharris62', 0, true).frame;
  const spectrum = essentia.Spectrum(windowed, FRAME_SIZE).spectrum;

  const yin = essentia.PitchYinFFT(spectrum, FRAME_SIZE, true, PITCH_MAX_HZ, PITCH_MIN_HZ, sampleRate, 1);

  // minFrequency must be > 0: at 0 a DC peak slips through and HPCP throws
  const peaks = essentia.SpectralPeaks(spectrum, 0, 4000, 60, 40, 'frequency', sampleRate);

  // Free: TuningFrequency takes exactly the peaks we already have
  let cents = null;
  try {
    cents = essentia.TuningFrequency(peaks.frequencies, peaks.magnitudes, 1).tuningCents;
  } catch (err) { /* too few peaks in this frame, skip it */ }

  // SpectralWhitening only returns {magnitudes} - frequencies still come from peaks
  const whitened = essentia.SpectralWhitening(spectrum, peaks.frequencies, peaks.magnitudes, 4000, sampleRate).magnitudes;
  // HPCP settings follow Essentia's standard recipe for chord estimation
  const hpcp = essentia.HPCP(
    peaks.frequencies, whitened,
    false,      // bandPreset
    500,        // bandSplitFrequency
    8,          // harmonics
    3500,       // maxFrequency
    false,      // maxShifted
    40,         // minFrequency
    true,       // nonLinear
    'unitMax',  // normalized
    tuningHz,   // referenceFrequency - the tuning measured on the previous pass
    sampleRate,
    12,         // size
    'cosine',   // weightType
    // windowSize 2, not the 1 this used to be. Measured over 120 trials per cell
    // at 6 dB SNR: guitar 90.0 -> 95.8%, piano 92.5 -> 100%. A wider window lets
    // each spectral peak contribute either side of its bin centre, which is what
    // absorbs partials that do not sit exactly on a bin - piano string stiffness
    // and any instrument tuned slightly off. Sweeping `harmonics` on top of this
    // changed nothing (8, 12 and 16 all scored identically), so there is no case
    // for per-instrument parameters: one setting wins for both.
    2
  ).hpcp;
  const chroma = essentia.vectorToArray(hpcp);

  frameVec.delete();
  windowed.delete();
  spectrum.delete();
  peaks.frequencies.delete();
  peaks.magnitudes.delete();
  whitened.delete();
  hpcp.delete();
  return { chroma: chroma, pitch: yin.pitch, conf: yin.pitchConfidence, cents: cents };
}

function median(arr) {
  arr.sort(function (a, b) { return a - b; });
  return arr[Math.floor(arr.length / 2)];
}

function analyse(audio, mode, hop) {
  const chromaSum = new Float32Array(12);
  const pitches = [];
  const centsList = [];
  const votes = new Map();
  let nFrames = 0;

  for (let start = 0; start + FRAME_SIZE <= audio.length; start += hop) {
    const f = frameFeatures(audio.subarray(start, start + FRAME_SIZE));
    for (let i = 0; i < 12; i++) chromaSum[i] += f.chroma[i];
    if (f.conf >= PITCH_CONF_MIN && f.pitch >= PITCH_MIN_HZ) pitches.push(f.pitch);
    if (f.cents !== null && isFinite(f.cents)) centsList.push(f.cents);
    if (mode !== 'note') {
      // Score-weighted vote across frames - far steadier than any single frame
      const m = matchChord(f.chroma);
      if (m) votes.set(m.chord, (votes.get(m.chord) || 0) + m.score);
    }
    nFrames++;
  }
  if (nFrames === 0) return { chroma: chromaSum, frames: 0 };
  for (let i = 0; i < 12; i++) chromaSum[i] /= nFrames;

  const out = { chroma: chromaSum, frames: nFrames };

  if (centsList.length) {
    // Drift towards the new reading rather than jumping: a single odd frame
    // should not move the reference the next pass is measured against.
    const cents = median(centsList);
    const measured = 440 * Math.pow(2, cents / 1200);
    tuningHz = tuningHz * 0.8 + measured * 0.2;
    out.tuningHz = tuningHz;
    out.tuningCents = 1200 * Math.log2(tuningHz / 440);
  }

  if (mode === 'note') {
    if (pitches.length) {
      out.hz = median(pitches);   // median is more outlier-resistant than the mean
      out.voiced = pitches.length;
    }
    return out;
  }

  let best = null, bestScore = 0, total = 0;
  votes.forEach(function (score, c) {
    total += score;
    if (score > bestScore) { bestScore = score; best = c; }
  });
  if (best && total > 0) {
    out.chord = best;
    out.confidence = bestScore / total;
  }
  return out;
}

self.onmessage = function (e) {
  const msg = e.data;

  if (msg.cmd === 'init') {
    sampleRate = msg.sampleRate;
    tuningHz = 440;
    return;
  }

  if (msg.cmd === 'analyse') {
    if (!essentia) return;   // not ready yet, skip this round
    const t0 = performance.now();
    let result;
    try {
      result = analyse(msg.audio, msg.mode, msg.hop);
    } catch (err) {
      self.postMessage({ type: 'result', seq: msg.seq, error: err.message, ms: performance.now() - t0 });
      return;
    }
    result.type = 'result';
    result.seq = msg.seq;
    result.mode = msg.mode;
    result.ms = performance.now() - t0;
    self.postMessage(result, [result.chroma.buffer]);
  }
};
