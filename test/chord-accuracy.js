#!/usr/bin/env node
'use strict';

/**
 * Chord-recognition accuracy sweep. Runs the exact chord-matching logic
 * shipped in worker.js (extracted live from the file, not copied - see
 * lib/load-worker-dsp.js) against synthetic guitar-like / piano-like
 * chords across all 12 roots and every CHORD_TYPES entry, through the real
 * Essentia.js pipeline (the same CDN build the app loads in the browser).
 *
 * This is the harness used to measure the CHORD_TYPES `prior` values in
 * worker.js - see its comments on the '7' / 'm7' / 'maj7' entries, and
 * CLAUDE.md's "Constants that were measured, not guessed" table. Re-run
 * this whenever touching CHORD_TYPES, the HPCP parameters in
 * frameFeatures(), or FRAME_SIZE - a change that looks safe on a few
 * manual chords can silently regress a whole register (that is how the
 * maj7/B7/Bm7 issues were found: they only show up above ~F# on a guitar).
 *
 * Usage:
 *   node test/chord-accuracy.js                  # clean, guitar-like, 5 trials/case
 *   npm test                                      # same, via package.json
 *   node test/chord-accuracy.js --trials=8
 *   node test/chord-accuracy.js --noise=0.15      # broadband noise, simulates a mixed/noisy recording
 *   node test/chord-accuracy.js --piano           # piano-like inharmonic tones instead of guitar
 *   node test/chord-accuracy.js --root=B          # one root only, fast iteration
 *   node test/chord-accuracy.js --type=maj7       # one chord quality only
 *   node test/chord-accuracy.js --quiet           # summary line only, no per-case failure list
 *
 * First run downloads ~2.9MB of Essentia.js (WASM + JS) into test/.cache/ -
 * safe to delete, it is re-downloaded on demand.
 *
 * Exit code is 1 if any non-symmetric-collision failure occurred, 0
 * otherwise, so this can gate a change if you want it to.
 */

const { loadEssentia } = require('./lib/essentia-node');
const { loadWorkerDSP } = require('./lib/load-worker-dsp');
const { mulberry32, mixChord, chordFreqs } = require('./lib/synth');

const SAMPLE_RATE = 48000;
const FRAME_SIZE = 4096;
const HOP = 2048; // matches QUALITY.full in index.html

const ROOT_HZ = {
  C: 261.63, 'C#': 277.18, D: 293.66, 'D#': 311.13, E: 329.63, F: 349.23,
  'F#': 369.99, G: 392.00, 'G#': 415.30, A: 440.00, 'A#': 466.16, B: 493.88
};

// worker.js's CHORD_TYPES comment documents these as deliberate: aug repeats
// every 4 semitones and dim7 every 3, so several roots share one HPCP
// template and the lowest-index root's name always wins - not a bug.
function isKnownSymmetricCollision(got, quality) {
  return !!got && (quality === 'aug' || quality === 'dim7') && got.endsWith(quality);
}

function parseArgs(argv) {
  const args = { trials: 5, noise: 0, piano: false, quiet: false, root: null, type: null };
  for (const arg of argv) {
    const [key, val] = arg.replace(/^--/, '').split('=');
    if (key === 'trials') args.trials = parseInt(val, 10);
    else if (key === 'noise') args.noise = parseFloat(val);
    else if (key === 'piano') args.piano = true;
    else if (key === 'quiet') args.quiet = true;
    else if (key === 'root') args.root = val;
    else if (key === 'type') args.type = val;
    else if (key === 'help' || arg === '-h') { printHelp(); process.exit(0); }
  }
  return args;
}

function printHelp() {
  const banner = require('fs').readFileSync(__filename, 'utf8').split('\n')
    .slice(0, 40).filter((l) => l.startsWith(' *') || l === '/**').join('\n');
  console.log(banner);
}

/** Simple string hash -> seed, so each (root, quality) gets its own stable but distinct RNG stream. */
function hashSeed(root, suffix) {
  let h = 0;
  for (const ch of root + '|' + suffix) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
}

function analyseChord(audio, dsp) {
  const result = dsp.analyse(audio, 'chord', HOP);
  return result.chord || null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  process.stderr.write('Loading Essentia.js (cached after first run)...\n');
  const essentia = await loadEssentia();
  const dsp = loadWorkerDSP();
  dsp.setEssentia(essentia);
  dsp.setSampleRate(SAMPLE_RATE);
  dsp.resetTuning();

  const roots = args.root ? [args.root] : Object.keys(ROOT_HZ);
  for (const r of roots) if (!ROOT_HZ[r]) throw new Error('Unknown --root: ' + r + ' (expected one of ' + Object.keys(ROOT_HZ).join(',') + ')');

  const types = args.type ? dsp.CHORD_TYPES.filter((t) => t.suffix === args.type) : dsp.CHORD_TYPES;
  if (args.type && types.length === 0) {
    throw new Error('Unknown --type: ' + args.type + ' (expected one of ' + dsp.CHORD_TYPES.map((t) => t.suffix || '(triad)').join(',') + ')');
  }

  let correct = 0, total = 0, symmetricCollisions = 0;
  const failures = [];

  for (const root of roots) {
    for (const type of types) {
      const expected = root + type.suffix;
      const rng = mulberry32(hashSeed(root, type.suffix));
      for (let trial = 0; trial < args.trials; trial++) {
        const freqs = chordFreqs(ROOT_HZ[root], type.iv);
        const audio = mixChord(freqs, 1.0, SAMPLE_RATE, rng, { piano: args.piano, noiseAmp: args.noise });
        const got = analyseChord(audio, dsp);
        total++;
        if (got === expected) correct++;
        else if (isKnownSymmetricCollision(got, type.suffix)) symmetricCollisions++;
        else failures.push(expected + ' -> ' + (got || '(no chord)'));
      }
    }
  }

  const label = [
    args.piano ? 'piano-like' : 'guitar-like (sawtooth)',
    args.noise ? 'noise=' + args.noise : 'clean',
    args.trials + ' trials/case'
  ].join(', ');
  console.log('chord-check accuracy: ' + label);
  console.log('  ' + correct + '/' + total + ' correct (' + (100 * correct / total).toFixed(1) + '%)');
  console.log('  known symmetric collisions (aug/dim7 - not bugs): ' + symmetricCollisions);
  console.log('  other failures: ' + failures.length);
  if (failures.length && !args.quiet) console.log('  ' + failures.join(', '));

  process.exitCode = failures.length > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err.stack || err);
  process.exitCode = 1;
});
