// Ear-bot (listening) — Rhythm bot step 1. Test-only; index.html is never modified.
//
// Records the game's REAL audio while a bot plays, then listens to it:
//   (a) how far each tap sound lands from the beat (tap attack vs the drums' attack)
//   (b) whether each tap's notes fit the chord the music is playing at that moment
// Known-bad CONTROLS (tap sound delayed, tap pitch shifted) prove the analysis can
// fail; they are the only hard pass/fail here. Clean songs are measured and
// reported (set EARBOT_STRICT=1 to make their verdicts fail the run too).
//
// Opt-in, ~10 min. Not part of the PR gate:
//   EARBOT=1 npx playwright test tests/earbot-listen.spec.js --project=desktop-chrome
// Options: EARBOT_SONGS=voidMetal,cyberBounce  EARBOT_SECS=40  EARBOT_STEMS=1 (also write
// music/taps WAVs)  EARBOT_STRICT=1. Output: results/earbot/*.md|json|wav and summary.md.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { boot } = require('./harness');
const { analyze, toMarkdown, summaryMarkdown, wav } = require('../earbot/analyze');

const ON = !!process.env.EARBOT;
const SECS = Number(process.env.EARBOT_SECS || 40);
const SONGS = (process.env.EARBOT_SONGS || 'voidMetal,cyberBounce,bluePulse,goldGroove,darkWave,toxicBreaks,cybermetal').split(',').filter(Boolean);
// Classic is the default every new player hears, so it gets every other tap.
const VOICES = ['classic', 'pluck', 'classic', 'kick', 'classic', 'rim'];
const OUT = path.join(__dirname, '..', 'results', 'earbot');
const INPAGE = fs.readFileSync(path.join(__dirname, '..', 'earbot', 'inpage.js'), 'utf8');

test.skip(!ON, 'opt-in: set EARBOT=1 (records ~40 s of real audio per run)');

async function record(page, label, { vibe, control = {}, bot = {} }) {
  test.setTimeout((SECS + 90) * 1000);
  const errors = await boot(page, { save: {
    level: 20, vibeUnlocks: { voidMetal: true, cybermetal: true, ascension: true },
    settings: { musicVibe: vibe, autoMatchVibe: false, tapVoice: 'classic' } } });
  // Pick the song in memory, the way the music menu does. (Loading a save resets
  // musicVibe to voidMetal unless it is one of the 7 original songs, so a saved
  // 'cybermetal' or 'ascension' would silently play Void Metal.)
  await page.evaluate((v) => { save.settings.musicVibe = v; }, vibe);
  await page.evaluate(INPAGE);
  await page.evaluate((o) => __earbot.wrap(o), control);
  await page.click('#startBtn');
  await page.waitForFunction(() => state === 'playing');
  await page.waitForFunction(() => audioCtx && audioCtx.state === 'running' && music.on, null, { timeout: 5000 });
  await page.evaluate(() => __earbot.startRecording());
  await page.evaluate((b) => __earbot.startBot(b), Object.assign({ mode: 'exact', voices: VOICES }, bot));
  await page.waitForTimeout(SECS * 1000);
  await page.evaluate(() => __earbot.stop());
  const assemble = await page.evaluate(() => __earbot.assemble());
  const meta = await page.evaluate(() => __earbot.meta());
  const stems = {};
  const STEP = 1 << 20;
  for (const [k, name] of [[0, 'music'], [1, 'taps'], [2, 'mix']]) {
    const parts = [];
    for (let f = 0; f < assemble.frames; f += STEP) parts.push(Buffer.from(await page.evaluate(([a, b, c]) => __earbot.slice(a, b, c), [k, f, STEP]), 'base64'));
    const buf = Buffer.concat(parts);
    stems[name] = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  }
  const r = analyze({ meta, stems, assemble, label });
  r.pageErrors = errors;
  r.recordedAt = new Date().toISOString();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, label + '.json'), JSON.stringify(r, null, 1));
  fs.writeFileSync(path.join(OUT, label + '.md'), toMarkdown(r) + '\n');
  fs.writeFileSync(path.join(OUT, label + '-mix.wav'), wav(stems.mix, meta.sampleRate));
  if (process.env.EARBOT_STEMS) for (const k of ['music', 'taps']) fs.writeFileSync(path.join(OUT, `${label}-${k}.wav`), wav(stems[k], meta.sampleRate));
  console.log('\n' + toMarkdown(r) + '\n');
  test.info().annotations.push({ type: 'earbot', description: `${label}: timing ${r.timing.verdict}; ` +
    Object.entries(r.byVoice).map(([v, s]) => `${v} pitch ${s.pitch} (${s.sourTaps}/${s.n} sour)`).join(', ') });
  expect(errors, 'page errors').toEqual([]);
  expect(r.vibe, 'the song that actually played').toBe(vibe);
  return r;
}

// The listening must be trustworthy before any verdict means anything.
function expectReliable(r) {
  const rl = r.reliability;
  expect(rl.gapShare, 'skipped audio share').toBeLessThanOrEqual(r.thresholds.gapMaxShare);
  expect(rl.kickSpreadMs, 'drum alignment spread (ms): recording timeline is off if this grows').toBeLessThanOrEqual(r.thresholds.kickSpreadMaxMs);
  expect(rl.tapMatch, 'share of tap sounds found in the audio').toBeGreaterThanOrEqual(r.thresholds.tapMatchMin);
  expect(rl.chordAgree, 'bars where the chord heard = the chord the sequencer played').toBeGreaterThanOrEqual(r.thresholds.chordAgreeMin);
}

// The summary reads the files back (a failed test restarts the worker, so memory can't be shared).
const LABELS = [...SONGS, 'voidMetal-human25', 'CONTROL-late30-cyberBounce', 'CONTROL-late60-voidMetal', 'CONTROL-tritone-cyberBounce'];

for (const vibe of SONGS) {
  test(`listen: ${vibe} (exact bot, Classic/Pluck/Kick/Rim)`, async ({ page }) => {
    const r = await record(page, vibe, { vibe });
    expectReliable(r);
    if (process.env.EARBOT_STRICT) {
      expect.soft(r.timing.verdict, 'timing').toBe('PASS');
      for (const [v, s] of Object.entries(r.byVoice)) expect.soft(s.pitch, `${v} pitch`).toBe('PASS');
    }
  });
}

// A steadier-than-average human: same song, taps spread ±25 ms (1 σ), seeded.
// Shows how far a PERFECT can sound from the beat. Report only.
test('listen: voidMetal, human model (jitter σ 25 ms)', async ({ page }) => {
  const r = await record(page, 'voidMetal-human25', { vibe: 'voidMetal', bot: { mode: 'human', sigmaMs: 25, seed: 11 } });
  expectReliable(r);
});

// ---- CONTROLS: the analysis must FAIL these. If it passes one, it is deaf. ----
test('CONTROL: tap sound delayed 30 ms → timing must FAIL (cyberBounce)', async ({ page }) => {
  const r = await record(page, 'CONTROL-late30-cyberBounce', { vibe: 'cyberBounce', control: { delayMs: 30 } });
  expectReliable(r);
  expect(r.timing.verdict).toBe('FAIL');
  expect(r.timing.tapVsBeatMs.median).toBeGreaterThanOrEqual(25);   // clean is ~2-5 ms; +30 must show up
  expect(r.timing.tapVsBeatMs.median).toBeLessThanOrEqual(45);
});

test('CONTROL: tap sound delayed 60 ms → timing must FAIL (voidMetal)', async ({ page }) => {
  const r = await record(page, 'CONTROL-late60-voidMetal', { vibe: 'voidMetal', control: { delayMs: 60 } });
  expectReliable(r);
  expect(r.timing.verdict).toBe('FAIL');
  expect(r.timing.tapVsBeatMs.median).toBeGreaterThanOrEqual(55);
  expect(r.timing.tapVsBeatMs.median).toBeLessThanOrEqual(75);
});

test('CONTROL: tap pitch shifted a tritone → pitch must FAIL, timing unaffected (cyberBounce, Pluck)', async ({ page }) => {
  // Pluck follows the chord (root + fifth), so clean it is all chord tones; +6
  // semitones turns every note into a b2 / b5 against the chord: always sour.
  const r = await record(page, 'CONTROL-tritone-cyberBounce', { vibe: 'cyberBounce', control: { semitones: 6 }, bot: { voices: ['pluck', 'classic'] } });
  expectReliable(r);
  expect(r.byVoice.pluck.pitch).toBe('FAIL');
  expect(r.byVoice.pluck.sourRate).toBeGreaterThanOrEqual(0.8);
  expect(r.timing.verdict).toBe('PASS');      // the pitch control must not leak into timing
});

test('summary', async () => {
  const results = LABELS.map((l) => path.join(OUT, l + '.json')).filter((f) => fs.existsSync(f)).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  test.skip(!results.length, 'no runs');
  const md = '# Ear-bot (listening) summary\n\n' + summaryMarkdown(results) + '\n\n' + results.map(toMarkdown).join('\n\n') + '\n';
  fs.writeFileSync(path.join(OUT, 'summary.md'), md);
  console.log('\n' + summaryMarkdown(results));
});
