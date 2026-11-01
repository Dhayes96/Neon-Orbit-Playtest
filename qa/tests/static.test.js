// Fast source-level guards (node:test, no browser). Run: node --test tests/static.test.js
// They pin invariants that the audit found broken/missing so a fix can't silently regress.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const src = fs.readFileSync(require('path').resolve(process.env.GAME_DIR || require('path').resolve(__dirname, '../..'), 'index.html'), 'utf8');

test('Conductor.swing() returns the same swing the sequencer uses (not the never-assigned music.active.prof)', () => {
  const m = src.match(/swing\(\)\s*\{[\s\S]*?\n    \}/);
  assert.ok(m, 'Conductor.swing() not found');
  const body = m[0].replace(/\/\/.*$/gm, '');
  const readsDeadField = /music\.active\.prof/.test(body) && !/\.prof\s*=|prof\s*:/.test(src.replace(m[0], ''));
  assert.ok(!readsDeadField, 'Conductor.swing() reads music.active.prof, which is never assigned, so note swing is always 0');
});

// KNOWN PHASE 2 FAILURE (T14 / RV-06). Runs and reports, but as `todo` it doesn't fail CI. Remove `todo` when T14 lands.
test('audio output latency is compensated somewhere (outputLatency/baseLatency/getOutputTimestamp)', { todo: 'known Phase 2 failure: T14 / RV-06' }, () => {
  assert.ok(/outputLatency|getOutputTimestamp|baseLatency/.test(src), 'no output-latency compensation in source');
});

// KNOWN PHASE 2 FAILURE (T8 / RV-05). Runs and reports, but as `todo` it doesn't fail CI. Remove `todo` when T8 lands.
test('tap judgement uses the input event timestamp, not handler time', { todo: 'known Phase 2 failure: T8 / RV-05' }, () => {
  const m = src.match(/function handleTap\([\s\S]*?\n  \}\n/);
  assert.ok(m, 'handleTap not found');
  assert.ok(/timeStamp/.test(m[0]), 'handleTap judges with clockNow() at handler time (ignores e.timeStamp)');
});

test('exactly one gameplay sequencer interval (setInterval(musicTick)', () => {
  assert.strictEqual((src.match(/setInterval\(musicTick/g) || []).length, 1);
});
