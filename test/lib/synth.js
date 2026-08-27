'use strict';

/**
 * Synthetic test audio - deterministic (seeded RNG) so a failure reproduces
 * exactly. Guitar-like tone is a sawtooth built from harmonics (amplitude
 * 1/n); piano-like adds string inharmonicity f_n = n*f0*sqrt(1+B*n^2), per
 * CLAUDE.md's own verification methodology (B ~= 2e-4 mid-range).
 *
 * CLAUDE.md's warning applies here too: run each configuration with several
 * different seeds before trusting a result. Oscillator phase is random by
 * design (real strums/keystrokes never share phase across notes) and a
 * single seed can make a borderline case look better or worse than it is.
 */

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sawtoothTone(freq, seconds, sampleRate, harmonics, rng) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const phases = [];
  for (let h = 1; h <= harmonics; h++) phases.push(rng() * 2 * Math.PI);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let s = 0;
    for (let h = 1; h <= harmonics; h++) {
      s += ((h % 2 === 0) ? -1 : 1) / h * Math.sin(2 * Math.PI * h * freq * t + phases[h - 1]);
    }
    out[i] = s * (2 / Math.PI);
  }
  return out;
}

function pianoTone(freq, seconds, sampleRate, harmonics, rng, inharmonicityB) {
  inharmonicityB = inharmonicityB === undefined ? 2e-4 : inharmonicityB;
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const phases = [];
  for (let h = 1; h <= harmonics; h++) phases.push(rng() * 2 * Math.PI);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let s = 0;
    for (let h = 1; h <= harmonics; h++) {
      const fh = h * freq * Math.sqrt(1 + inharmonicityB * h * h);
      s += (1 / h) * Math.sin(2 * Math.PI * fh * t + phases[h - 1]);
    }
    out[i] = s;
  }
  return out;
}

/** Cheap low-passed white noise - stands in for room hiss / other instruments / a busy mix. */
function addBroadbandNoise(mix, rng, amp) {
  let state = 0;
  for (let i = 0; i < mix.length; i++) {
    const white = rng() * 2 - 1;
    state = state * 0.98 + white * 0.02;
    mix[i] += state * amp * 8;
  }
}

/** Mix several note frequencies (equal amplitude) into one clip, normalised with headroom. */
function mixChord(freqs, seconds, sampleRate, rng, opts) {
  opts = opts || {};
  const toneFn = opts.piano ? pianoTone : sawtoothTone;
  const harmonics = opts.harmonics || 12;
  const n = Math.round(seconds * sampleRate);
  const mix = new Float32Array(n);
  for (const f of freqs) {
    const tone = toneFn(f, seconds, sampleRate, harmonics, rng);
    for (let i = 0; i < n; i++) mix[i] += tone[i];
  }
  if (opts.noiseAmp) addBroadbandNoise(mix, rng, opts.noiseAmp);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(mix[i]));
  if (peak > 0) for (let i = 0; i < n; i++) mix[i] /= peak * 1.2; // headroom, avoid clipping
  return mix;
}

function chordFreqs(rootHz, semitoneIntervals) {
  return semitoneIntervals.map((st) => rootHz * Math.pow(2, st / 12));
}

module.exports = { mulberry32, sawtoothTone, pianoTone, addBroadbandNoise, mixChord, chordFreqs };
