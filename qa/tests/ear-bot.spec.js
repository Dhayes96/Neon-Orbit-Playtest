// Ear-bot: listens to the game's real rendered audio and measures, per song,
// (a) how far each tap SOUND lands from the nearest 1/16 step of the music and
// (b) whether the tap sound's pitch fits the key/chord the music is playing.
// Test-only: index.html is not modified. Rhythm-bot step 1 (Dennel OK, Nov 9 2026).
//
// Validation first: the "control-*" tests replace the tap sound with a known
// signal (the game's own tone(), scheduled on every beat). Known-good must pass;
// known-late, known-off-key and a bot tapping 45 ms late must be FLAGGED. Those
// are hard assertions: if the analyzer can't fail them, its song results mean nothing.
//
// Song results are raw numbers in results/ear-*.json. The song checks are soft
// (expect.soft) so every song is measured and reported even when one fails.
//
// Evidence label: automated (headless browser). It measures the game's own audio
// before the output device. It can't hear device latency or judge feel; Dennel's
// ear on a real device is the reference when they disagree.
//
//   npx playwright test tests/ear-bot.spec.js --project=chrome-ear
//   EAR_SONGS=cyberBounce,voidMetal EAR_SECONDS=40 npx playwright test tests/ear-bot.spec.js --project=chrome-ear
const { test, expect } = require('@playwright/test');
const { boot, installProbes, writeResult } = require('./harness');
const { installRecorder, stopRecorder, installTapLog, startEarTapper, installControlTones } = require('./ear-recorder');
const { analyze } = require('./ear-analysis');

const SONGS = (process.env.EAR_SONGS || 'cyberBounce,bluePulse,toxicBreaks,goldGroove,darkWave,crimsonDrive,voidMetal').split(',');
const SECONDS = Number(process.env.EAR_SECONDS || 30);

async function measure(page, { vibe, tapVoice = 'classic', control = null, lateMs = 0, seconds = SECONDS }) {
  const errors = await boot(page, { save: { level: 20, settings: { musicVibe: vibe, autoMatchVibe: false, tapVoice, lowGraphics: true } } });
  await installProbes(page);
  await page.click('#startBtn');
  await page.waitForFunction(() => state === 'playing');
  await page.waitForFunction(() => audioCtx && audioCtx.state === 'running' && music.on, null, { timeout: 5000 });
  await installRecorder(page);
  if (control) await installControlTones(page, control); else await installTapLog(page);
  await startEarTapper(page, { lateMs });
  await page.waitForTimeout(seconds * 1000);
  await page.evaluate(() => { window.__botStop = true; });
  const rec = await stopRecorder(page);
  const { steps, tapLog, botLog, st } = await page.evaluate(() => ({
    steps: __qa.steps.map((s) => ({ w: s.w, step: s.step, bar: s.bar })), tapLog: window.__tapLog, botLog: window.__botLog,
    st: { state, stage, bpm, vibe: save.settings.musicVibe, tapVoice: save.settings.tapVoice, perfects: runStats.perfects, goods: runStats.goods, oks: runStats.oks, misses: runStats.misses },
  }));
  const res = analyze({ rec, steps, tapLog, botLog, judgeGrades: ['perfect', 'good', 'ok', 'control'] });
  return { errors, recorderGaps: rec.gaps, recorderGapDetail: rec.gapDetail, final: st, ...res };
}

function summary(name, r) {
  const t = r.timingVsStepMs, p = r.pitch;
  console.log(`ear ${name}: taps=${r.tapSoundsDetected} timing p50=${t.p50} p90abs=${t.absP90} ms flag=${r.timingFlag} | fit=${p.fitShare} heardInKey=${p.audioInKeyShare} heardClash=${p.audioClashShare} chordTone=${p.gameChordToneShare} chordClash=${p.gameChordClashShare} flag=${r.pitchFlag} | bot input p50=${r.timingBreakdown.botInputVsStepMs.p50} ms`);
}


// ---------- analyzer validation (hard) ----------
test('control-good: known on-step, in-key tone is NOT flagged', async ({ page }) => {
  const r = await measure(page, { vibe: 'cyberBounce', control: { shiftMs: 0, interval: 24 }, seconds: 20 });
  writeResult('ear-control-good', r); summary('control-good', r);
  // Chunks are placed by their own audio frame number, so a skipped render block
  // (seen once early in a run on headless Chromium: 896 frames) leaves silence, not
  // a time shift. Allow at most 1% of the recording to be missing.
  const missing = (r.recorderGapDetail || []).reduce((s, g) => s + g.missingFrames, 0);
  expect(missing / (r.recordedSeconds * r.sampleRate)).toBeLessThan(0.01);
  expect(r.tapSoundsDetected).toBeGreaterThan(15);
  expect(Math.abs(r.timingVsStepMs.p50)).toBeLessThanOrEqual(5);
  expect(r.timingFlag).toBe(false);
  expect(r.pitchFlag).toBe(false);
});

test('control-late: known tone 45 ms after the beat IS flagged and reads ~45 ms', async ({ page }) => {
  const r = await measure(page, { vibe: 'cyberBounce', control: { shiftMs: 45, interval: 24 }, seconds: 20 });
  writeResult('ear-control-late', r); summary('control-late', r);
  expect(Math.abs(r.timingVsStepMs.p50 - 45)).toBeLessThanOrEqual(6);
  expect(r.timingFlag).toBe(true);
});

test('control-offkey: known tritone tone IS flagged', async ({ page }) => {
  const r = await measure(page, { vibe: 'cyberBounce', control: { shiftMs: 0, interval: 30 }, seconds: 20 });
  writeResult('ear-control-offkey', r); summary('control-offkey', r);
  expect(r.pitchFlag).toBe(true);
  expect(r.pitch.gameChordClashShare).toBeGreaterThan(0.5);
});

test('control-late-bot: real game tap sound, bot tapping 45 ms late, IS flagged', async ({ page }) => {
  const r = await measure(page, { vibe: 'cyberBounce', lateMs: 45, seconds: 20 });
  writeResult('ear-control-late-bot', r); summary('control-late-bot', r);
  expect(r.timingVsStepMs.p50).toBeGreaterThanOrEqual(39);
  expect(r.timingFlag).toBe(true);
});

// ---------- the songs (raw numbers; soft checks) ----------
for (const vibe of SONGS) {
  test(`song ${vibe}: tap sound timing + pitch (Classic tap voice, default for new players)`, async ({ page }) => {
    const r = await measure(page, { vibe });
    writeResult(`ear-${vibe}-classic`, r); summary(`${vibe}/classic`, r);
    expect(r.errors).toEqual([]);
    expect(r.tapSoundsDetected).toBeGreaterThan(10);
    // Timing: tap-sound-vs-step includes the bot's own input jitter (headless main-thread
    // hitches; see timingBreakdown.botInputVsStepMs), so the song check is on what the GAME
    // adds between the tap handler running and its sound starting. vs-step stays in the JSON
    // (timingFlag) and the controls above prove that measurement can fail.
    const gameAdd = r.timingBreakdown.soundAfterTapHandlerMs;
    expect.soft(gameAdd.p90, `${vibe}: delay the game adds between tap and tap sound (p50 ${gameAdd.p50}, p90 ${gameAdd.p90} ms)`).toBeLessThanOrEqual(10);
    expect.soft(r.pitchFlag, `${vibe}: tap pitch vs key (fit ${r.pitch.fitShare}, heard clash ${r.pitch.audioClashShare}, chord clash ${r.pitch.gameChordClashShare})`).toBe(false);
  });
}

// Comparison: a chord-following voice on two songs, to show whether the voice choice changes the pitch result.
for (const vibe of ['cyberBounce', 'voidMetal'].filter((v) => SONGS.includes(v))) {
  test(`song ${vibe}: Synth Pluck tap voice (chord-following) for comparison`, async ({ page }) => {
    const r = await measure(page, { vibe, tapVoice: 'pluck' });
    writeResult(`ear-${vibe}-pluck`, r); summary(`${vibe}/pluck`, r);
    expect(r.errors).toEqual([]);
    expect.soft(r.timingBreakdown.soundAfterTapHandlerMs.p90, `${vibe}/pluck game-added delay`).toBeLessThanOrEqual(10);
    expect.soft(r.pitchFlag, `${vibe}/pluck pitch`).toBe(false);
  });
}
