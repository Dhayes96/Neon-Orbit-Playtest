const { test, expect } = require('@playwright/test');
const { boot, installProbes, startBot, stats, writeResult } = require('./harness');

// Tolerances (seconds/ms). See agent3-qa.md §4 for rationale.
const TOL = {
  gridErrMs: 2,          // generated note vs the audio step it claims to sit on
  clockDriftMsPerMin: 1, // clockNow() vs audioCtx.currentTime while running
  botJudgeErrP95Ms: 25,  // frame-quantised autoplayer error (1.5 frames @60Hz)
};

async function startRun(page) {
  await page.click('#startBtn');
  await page.waitForFunction(() => state === 'playing');
  await page.waitForFunction(() => audioCtx && audioCtx.state === 'running' && music.on, null, { timeout: 5000 });
}

function gridAnalysis(steps, notes) {
  const lastW = steps.length ? steps[steps.length - 1].when : 0;
  const out = [];
  for (const n of notes) {
    if (n.audio == null || n.audio > lastW - 0.05) continue;
    if (n.cleared && !process.env.INCLUDE_CLEARED) continue; // notes the game deletes at level-up/boss are never shown to the player
    let best = null, bd = Infinity;
    for (const s of steps) { const d = Math.abs(n.audio - s.w); if (d < bd) { bd = d; best = s; } }
    let bestU = null, bu = Infinity;
    for (const s of steps) { const d = Math.abs(n.audio - s.when); if (d < bu) { bu = d; bestU = s; } }
    out.push({ errMs: (n.audio - best.w) * 1000, errUnswungMs: (n.audio - bestU.when) * 1000, step: best.step,
      accent: n.accents[best.step] || 0, sw: best.sw, conductorSwing: n.conductorSwing, stage: n.stage, bpm: n.bpm,
      stepBpm: best.bpm, leadAheadS: n.hitTime - n.nowG });
  }
  return out;
}

test('audio clock sync: clockNow() tracks audioCtx.currentTime, granularity + drift', async ({ page }) => {
  const errors = await boot(page);
  await installProbes(page);
  await startRun(page);
  await startBot(page);
  const samples = await page.evaluate(async () => {
    const out = [];
    for (let i = 0; i < 31; i++) {
      out.push({ perf: performance.now() / 1000, clk: clockNow(), ac: audioCtx.currentTime, st: audioCtx.state });
      await new Promise((r) => setTimeout(r, 1000));
    }
    // Granularity: how often does the audio clock (and so clockNow) actually advance?
    const deltas = []; let prev = clockNow(); const end = performance.now() + 200;
    while (performance.now() < end) { const c = clockNow(); if (c !== prev) { deltas.push((c - prev) * 1000); prev = c; } }
    const acDeltas = []; let pa = audioCtx.currentTime; const end2 = performance.now() + 200;
    while (performance.now() < end2) { const a = audioCtx.currentTime; if (a !== pa) { acDeltas.push((a - pa) * 1000); pa = a; } }
    return { out, deltas, acDeltas };
  });
  const s0 = samples.out[0], sN = samples.out[samples.out.length - 1];
  const mins = (sN.perf - s0.perf) / 60;
  const clkVsAcMs = ((sN.clk - s0.clk) - (sN.ac - s0.ac)) * 1000;
  const acVsPerfMs = ((sN.ac - s0.ac) - (sN.perf - s0.perf)) * 1000;
  const taps = await page.evaluate(() => __qa.taps);
  const result = {
    durationMin: mins, clkVsAcMs, clkVsAcMsPerMin: clkVsAcMs / mins, acVsPerfMs, acVsPerfMsPerMin: acVsPerfMs / mins,
    clockNowStepMs: stats(samples.deltas), audioCurrentTimeStepMs: stats(samples.acDeltas),
    botJudgeErrMs: stats(taps.map((t) => t.errMs)), botResults: taps.reduce((m, t) => (m[t.res] = (m[t.res] || 0) + 1, m), {}),
    errors,
  };
  writeResult('timing-clock', result);
  expect(Math.abs(result.clkVsAcMsPerMin)).toBeLessThan(TOL.clockDriftMsPerMin);
  expect(errors).toEqual([]);
});

for (const vibe of ['cyberBounce', 'goldGroove', 'bluePulse']) {
  test(`note grid alignment (${vibe}): generated notes sit on scheduled audio steps`, async ({ page }) => {
    const errors = await boot(page, { save: { settings: { musicVibe: vibe } } });
    await installProbes(page);
    await startRun(page);
    await startBot(page);
    await page.waitForTimeout(40_000);
    const { steps, notes, taps, st } = await page.evaluate(() => ({ steps: __qa.steps, notes: __qa.notes, taps: __qa.taps, st: { stage, bpm, state } }));
    const g = gridAnalysis(steps, notes);
    const abs = g.map((x) => Math.abs(x.errMs));
    const offGrid = g.filter((x) => Math.abs(x.errMs) > TOL.gridErrMs);
    const swungSteps = g.filter((x) => x.step % 4 === 2);
    const result = {
      vibe, final: st, notesSpawned: notes.length, notesBeforeConductorReady: notes.filter((n) => n.audio == null).length,
      analysed: g.length, absErrMs: stats(abs), offGridCount: offGrid.length,
      offGridSample: offGrid.slice(0, 8), trackSwingValues: [...new Set(steps.map((s) => s.sw))],
      conductorSwingValues: [...new Set(notes.map((n) => n.conductorSwing))],
      notesOnSwungSteps: swungSteps.length, swungStepErrMs: swungSteps.length ? stats(swungSteps.map((x) => x.errMs)) : null,
      accentHistogram: g.reduce((m, x) => (m[x.accent] = (m[x.accent] || 0) + 1, m), {}),
      botJudgeErrMs: stats(taps.map((t) => t.errMs)), botResults: taps.reduce((m, t) => (m[t.res] = (m[t.res] || 0) + 1, m), {}),
      errors,
    };
    writeResult('timing-grid-' + vibe, result);
    expect(errors).toEqual([]);
    expect.soft(result.offGridCount, `notes off the audio grid by >${TOL.gridErrMs}ms`).toBe(0);
  });
}

test('BPM transition: notes scheduled during a tempo ramp stay on the audio grid', async ({ page }) => {
  const errors = await boot(page);
  await installProbes(page);
  await startRun(page);
  await startBot(page);
  await page.waitForTimeout(6000);
  // Jump progression to 2 hits before stage 6 (first phase change + largest early BPM step).
  await page.evaluate(() => { hitsTotal = stageHitsNeeded(6, diff) - 2; __qa.markT = clockNow() - startTime; });
  await page.waitForTimeout(25_000);
  const { steps, notes, taps, st, markT } = await page.evaluate(() => ({ steps: __qa.steps, notes: __qa.notes, taps: __qa.taps, markT: __qa.markT, st: { stage, bpm, state, phase: music.phaseIndex } }));
  const g = gridAnalysis(steps, notes);
  const ramp = g.filter((x) => Math.abs(x.bpm - x.stepBpm) > 0.05);
  const steady = g.filter((x) => Math.abs(x.bpm - x.stepBpm) <= 0.05);
  const bpmTrace = steps.filter((_, i) => i % 16 === 0).map((s) => ({ ac: +s.when.toFixed(2), bpm: +s.bpm.toFixed(2), phase: s.phaseKey }));
  const result = {
    final: st, analysed: g.length,
    duringRamp: { n: ramp.length, absErrMs: ramp.length ? stats(ramp.map((x) => Math.abs(x.errMs))) : null, sample: ramp.slice(0, 10) },
    steady: { n: steady.length, absErrMs: steady.length ? stats(steady.map((x) => Math.abs(x.errMs))) : null },
    bpmTrace: bpmTrace.slice(0, 60), botResults: taps.reduce((m, t) => (m[t.res] = (m[t.res] || 0) + 1, m), {}), errors,
  };
  writeResult('timing-bpm-transition', result);
  expect(errors).toEqual([]);
  expect(st.stage).toBeGreaterThanOrEqual(6);
  expect.soft(ramp.filter((x) => Math.abs(x.errMs) > TOL.gridErrMs).length, 'ramp notes off-grid').toBe(0);
});

test('state: hidden tab freezes the run and resumes without mass misses', async ({ page }) => {
  const errors = await boot(page);
  await installProbes(page);
  await startRun(page);
  await startBot(page);
  await page.waitForTimeout(5000);
  const before = await page.evaluate(() => ({ misses: runStats.misses, t: clockNow() - startTime, pending: notes.filter((n) => !n.hit && !n.missed).length }));
  // Simulate backgrounding (Playwright cannot truly hide a tab): override document.hidden + fire events.
  await page.evaluate(() => { window.__botStop = true; Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(4000);
  const hidden = await page.evaluate(() => ({ ac: audioCtx.state, t: clockNow() - startTime }));
  await page.evaluate(() => { delete document.hidden; delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({ misses: runStats.misses, t: clockNow() - startTime, ac: audioCtx.state, state, musicOn: music.on }));
  const result = { before, hidden, after, gameTimeAdvancedWhileHiddenS: after.t - before.t - 0.3, errors };
  writeResult('state-visibility', result);
  expect(hidden.ac).toBe('suspended');
  expect(after.ac).toBe('running');
  expect(after.misses - before.misses).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test('perf: frame-time budget during 30s of autoplay (headless = smoke only)', async ({ page }) => {
  const errors = await boot(page);
  await installProbes(page);
  await startRun(page);
  await startBot(page);
  await page.evaluate(() => { __qa.frames.length = 0; });
  await page.waitForTimeout(30_000);
  const { frames, lt } = await page.evaluate(() => ({ frames: __qa.frames.slice(5), lt: window.__longTasks }));
  const result = { frameMs: stats(frames), over33: frames.filter((f) => f > 33.4).length, over50: frames.filter((f) => f > 50).length,
    longTasks: lt.length, longTaskMaxMs: lt.length ? Math.max(...lt.map((x) => x.dur)) : 0, errors };
  writeResult('perf-frames', result);
  expect.soft(result.frameMs.p95).toBeLessThan(20);
  expect(errors).toEqual([]);
});

test('ear-bot: a player tapping exactly on the audible step, across a BPM ramp', async ({ page }) => {
  const errors = await boot(page);
  await installProbes(page);
  await startRun(page);
  await startBot(page, { mode: 'ear' });
  await page.waitForTimeout(6000);
  await page.evaluate(() => { hitsTotal = stageHitsNeeded(6, diff) - 2; });
  await page.waitForTimeout(25_000);
  const { taps, st } = await page.evaluate(() => ({ taps: __qa.taps, st: { stage, bpm, state, energy } }));
  const res = taps.reduce((m, t) => (m[t.res] = (m[t.res] || 0) + 1, m), {});
  const result = { final: st, taps: taps.length, results: res, judgeErrMs: stats(taps.map((t) => t.errMs)),
    nonPerfectSample: taps.filter((t) => t.res !== 'PERFECT').slice(0, 12), errors };
  writeResult('timing-ear-bot', result);
  expect(errors).toEqual([]);
  expect.soft((res.PERFECT || 0) / taps.length, 'share of on-the-beat taps judged PERFECT').toBeGreaterThan(0.95);
});

// CROSS-REVIEW ADDITION (RV-03): rings still in flight when the player returns must either be
// cleared by the game or land on a scheduled audio step. Baseline is expected to FAIL.
test('state: in-flight notes stay on the audio grid (or are cleared) after a tab resume', async ({ page }) => {
  // RV-03 fixed by Phase 2 T6 (auto-pause clears in-flight rings; whole-step re-anchor). Now a regression guard.
  const errors = await boot(page);
  await installProbes(page);
  await startRun(page);
  await startBot(page);
  await page.waitForFunction(() => state === 'playing' && notes.filter((n) => !n.hit && !n.missed).length >= 2 && (clockNow() - startTime) > 3, null, { timeout: 30000 });
  await page.evaluate(() => { window.__botStop = true; Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(3000);
  await page.evaluate(() => { delete document.hidden; delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => audioCtx.state === 'running');
  await page.waitForTimeout(120);
  const inFlight = await page.evaluate(() => { const now = clockNow() - startTime; window.__resumeState = state;
    return notes.filter((n) => !n.missed && n.hitTime > now + 0.05).map((n) => ({ hitTime: n.hitTime, audio: Conductor.gameToAudio(n.hitTime) })); });
  await page.waitForTimeout(4000);
  const steps = await page.evaluate(() => __qa.steps);
  const errs = inFlight.map((n) => { let bd = Infinity, e = 0; for (const s of steps) { const d = Math.abs(n.audio - s.w); if (d < bd) { bd = d; e = (n.audio - s.w) * 1000; } } return e; });
  const st = await page.evaluate(() => window.__resumeState);
  const result = { stateAtResume: st, inFlight: inFlight.length, errMs: errs, errors };
  writeResult('state-resume-grid', result);
  expect(errors).toEqual([]);
  expect.soft(errs.filter((e) => Math.abs(e) > 2).length, 'in-flight notes off-grid after resume').toBe(0);
});
