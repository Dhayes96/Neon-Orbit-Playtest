// T3 / RV-08: long chaos soak (report-only). Plays RV_SOAK_MIN minutes
// (default 10) with the chart bot, cycling vibes and forcing stage jumps,
// then reports ring pairs closer than max(MIN_NOTE_GAP, windows().ok*1.7)
// and note density (spawned notes per second of playing time, per stage).
// Run: RV_SOAK_MIN=10 npx playwright test tests/rv08-soak.spec.js --project=desktop-chrome
const { test, expect } = require('@playwright/test');
const { boot, installProbes, startBot, writeResult } = require('./harness');

const MIN = Number(process.env.RV_SOAK_MIN || 10);
const VIBES = ['cyberBounce', 'goldGroove', 'bluePulse'];
const SEG_MS = 30_000;

test(`RV-08 soak: ${MIN} min, pairs below minGap + density per stage (report-only)`, async ({ page }) => {
  test.setTimeout((MIN * 60 + 120) * 1000);
  const errors = await boot(page, { save: { settings: { musicVibe: VIBES[0] } } });
  await installProbes(page);
  // minGap depends on the stage's OK window, so record it per note at spawn time
  await page.evaluate(() => {
    const prev = spawnNote;
    window.spawnNote = function (hitTime, index) {
      const r = prev.apply(this, arguments);
      const q = __qa.notes[__qa.notes.length - 1];
      if (q && q.hitTime === hitTime) { q.minGap = Math.max(MIN_NOTE_GAP, windows().ok * 1.7); q.run = __qa.restarts || 0; }
      return r;
    };
  });
  await page.click('#startBtn');
  await page.waitForFunction(() => state === 'playing');
  await startBot(page);
  // per-stage playing-time sampler + game-over auto-restart (cycles vibes)
  await page.evaluate((vibes) => {
    const qa = window.__qa; qa.playSec = {}; qa.restarts = 0; let last = performance.now();
    (function f(ts) {
      const dt = (ts - last) / 1000; last = ts;
      if (state === 'playing' || state === 'bossBattle') qa.playSec[stage] = (qa.playSec[stage] || 0) + dt;
      if (state === 'gameover') { qa.restarts++; save.settings.musicVibe = vibes[qa.restarts % vibes.length]; startGame(false); }
      requestAnimationFrame(f);
    })(performance.now());
  }, VIBES);
  const segs = Math.max(1, Math.round(MIN * 60_000 / SEG_MS));
  for (let i = 0; i < segs; i++) {
    await page.waitForTimeout(SEG_MS);
    // chaos: jump ahead a few stages every other segment (wraps back to 1 after 12)
    if (i % 2 === 1) await page.evaluate(() => { if (state === 'playing') { const target = stage >= 12 ? 1 : stage + 3; if (target > stage) hitsTotal = stageHitsNeeded(target, diff) - 1; } });
  }
  const r = await page.evaluate(() => ({ notes: __qa.notes, playSec: __qa.playSec, restarts: __qa.restarts, taps: __qa.taps }));
  const live = r.notes.filter((n) => !n.cleared);
  // compare neighbours within the same run only (hitTime restarts each run)
  const sorted = [...live].sort((a, b) => (a.run - b.run) || (a.hitTime - b.hitTime));
  const close = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    if (a.run !== b.run) continue;
    const g = b.hitTime - a.hitTime, need = b.minGap;   // the rule in force when b was scheduled
    if (g < need - 1e-6) close.push({ gapMs: +(g * 1000).toFixed(1), minGapMs: +(need * 1000).toFixed(1), stage: b.stage, bpm: +b.bpm.toFixed(1) });
  }
  const perStage = {};
  for (const n of live) perStage[n.stage] = (perStage[n.stage] || 0) + 1;
  const density = {};
  for (const s of Object.keys(perStage)) if (r.playSec[s] > 5) density[s] = +(perStage[s] / r.playSec[s]).toFixed(3);
  const res = { minutes: MIN, game: process.env.GAME_DIR, liveNotes: live.length, restarts: r.restarts,
    pairsBelowMinGap: close.length, closeSample: close.slice(0, 20), notesPerStage: perStage,
    playSecPerStage: Object.fromEntries(Object.entries(r.playSec).map(([k, v]) => [k, +v.toFixed(1)])), densityNotesPerSec: density,
    botResults: r.taps.reduce((m, t) => (m[t.res] = (m[t.res] || 0) + 1, m), {}), errors };
  writeResult('rv08-soak', res);
  console.log(JSON.stringify({ pairsBelowMinGap: res.pairsBelowMinGap, liveNotes: res.liveNotes, density: res.densityNotesPerSec, restarts: res.restarts }));
  expect(errors).toEqual([]);   // report-only otherwise
});
