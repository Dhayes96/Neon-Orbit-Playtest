// Self-test for the ear-bot analyzer on synthetic audio (node:test, no browser).
// Proves the analyzer can FAIL: known-late and known-off-key signals must be flagged,
// and a known-good signal must not be. Run: node --test tests/ear-analysis.selftest.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { analyze } = require('./ear-analysis');

const SR = 48000, BPM = 100, STEP = 60 / BPM / 4, SECONDS = 16;
const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);

// A minor-ish backing: A2 bass + A-C-E pad, continuous, plus a kick on every beat.
function music() {
  const x = new Float32Array(SR * SECONDS);
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    x[i] = 0.15 * Math.sin(2 * Math.PI * midiHz(45) * t) + 0.06 * Math.sin(2 * Math.PI * midiHz(57) * t)
         + 0.05 * Math.sin(2 * Math.PI * midiHz(60) * t) + 0.05 * Math.sin(2 * Math.PI * midiHz(64) * t)
         + 0.03 * Math.sin(2 * Math.PI * midiHz(67) * t) + 0.02 * Math.sin(2 * Math.PI * midiHz(62) * t);
  }
  return x;
}
// Tap track built like the game's tone(): triangle-ish, 6 ms exponential attack, 45 ms decay.
function taps(times, midi) {
  const x = new Float32Array(SR * SECONDS);
  for (const t0 of times) {
    const s0 = Math.round(t0 * SR), n = Math.round(0.065 * SR), f = midiHz(midi);
    for (let i = 0; i < n && s0 + i < x.length; i++) {
      const t = i / SR;
      const g = t < 0.006 ? 0.0001 * (450 ** (t / 0.006)) : 0.045 * ((0.0001 / 0.045) ** ((t - 0.006) / 0.039));
      x[s0 + i] += Math.min(0.045, g) * (2 / Math.PI) * Math.asin(Math.sin(2 * Math.PI * f * t));
    }
  }
  return x;
}
const steps = Array.from({ length: Math.floor(SECONDS / STEP) }, (_, i) => ({ step: i, w: i * STEP }));
const beatTimes = steps.filter((s) => s.step % 4 === 0 && s.w > 5 && s.w < SECONDS - 0.5).map((s) => s.w);
const run = (shiftMs, midi) => analyze({ rec: { sr: SR, startFrame: 0, tap: taps(beatTimes.map((t) => t + shiftMs / 1000), midi), music: music() }, steps });

test('known-good: on the step, in key (A5 over A minor) -> not flagged', () => {
  const r = run(0, 81);
  assert.ok(r.timingVsStepMs.n >= 15, 'taps detected');
  assert.ok(Math.abs(r.timingVsStepMs.p50) <= 3, `median ${r.timingVsStepMs.p50} ms`);
  assert.strictEqual(r.timingFlag, false);
  assert.strictEqual(r.pitchFlag, false, JSON.stringify(r.pitch));
});

test('known-late: 45 ms after the step -> timing flagged, reads ~45 ms', () => {
  const r = run(45, 81);
  assert.ok(Math.abs(r.timingVsStepMs.p50 - 45) <= 4, `median ${r.timingVsStepMs.p50} ms`);
  assert.strictEqual(r.timingFlag, true);
});

test('known-early: 30 ms before the step -> timing flagged, reads ~-30 ms', () => {
  const r = run(-30, 81);
  assert.ok(Math.abs(r.timingVsStepMs.p50 + 30) <= 4, `median ${r.timingVsStepMs.p50} ms`);
  assert.strictEqual(r.timingFlag, true);
});

test('known-off-key: D#5 (tritone) over A minor -> pitch flagged', () => {
  const r = run(0, 75);
  assert.strictEqual(r.pitchFlag, true, JSON.stringify(r.pitch));
  assert.ok(r.pitch.fitShare < 0.5);
});

test('known-clash: G#5 against a strong A in the music -> semitone clash flagged', () => {
  const r = run(0, 80);
  assert.strictEqual(r.pitchFlag, true, JSON.stringify(r.pitch));
  assert.ok(r.pitch.audioClashShare > 0.5 || r.pitch.fitShare < 0.5);
});
