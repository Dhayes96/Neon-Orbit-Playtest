const { test, expect } = require('@playwright/test');
const { boot, installProbes, startBot, stats, writeResult } = require('./harness');

// Low-end device proxy: CDP CPU throttling. Detects sequencer steps that were
// DROPPED (musicTick skips steps that fall behind the audio clock, line ~4024)
// and frame-time blowups. Chromium-only (CDP).
test('stress: 6x CPU throttle — dropped music steps and frame budget', async ({ page }) => {
  const errors = await boot(page);
  await installProbes(page);
  await page.click('#startBtn');
  await page.waitForFunction(() => state === 'playing' && audioCtx && audioCtx.state === 'running' && music.on);
  await startBot(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  await page.evaluate(() => { __qa.frames.length = 0; __qa.steps.length = 0; });
  await page.waitForTimeout(20_000);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const { steps, frames, taps } = await page.evaluate(() => ({ steps: __qa.steps, frames: __qa.frames.slice(3), taps: __qa.taps }));
  let dropped = 0; const gaps = [];
  for (let i = 1; i < steps.length; i++) {
    const exp = steps[i - 1].when + steps[i - 1].stepDur;
    const missing = Math.round((steps[i].when - steps[i - 1].when) / steps[i - 1].stepDur) - 1;
    // index gap = steps skipped in the bar (dropped, line ~4024);
    // time gap with contiguous index = re-anchor (line ~4015) that SHIFTS the music grid phase.
    const idxGap = ((steps[i].step - steps[i - 1].step + 16) % 16) - 1;
    if (missing > 0) { dropped += missing; gaps.push({ at: +steps[i - 1].when.toFixed(3), missing, idxGap, kind: idxGap > 0 ? 'dropped-steps' : 'reanchor-phase-shift', shiftMs: +((steps[i].when - exp) * 1000).toFixed(1) }); }
  }
  const lateSched = steps.map((s) => (s.when - s.acNow) * 1000);
  const result = { stepsScheduled: steps.length, droppedSteps: dropped, byKind: gaps.reduce((m, g) => (m[g.kind] = (m[g.kind] || 0) + 1, m), {}), allGaps: gaps, gaps: gaps.slice(0, 10),
    scheduleHeadroomMs: stats(lateSched), frameMs: stats(frames),
    botResults: taps.reduce((m, t) => (m[t.res] = (m[t.res] || 0) + 1, m), {}), errors };
  writeResult('stress-cpu6x', result);
  expect(errors).toEqual([]);
  expect.soft(dropped, 'music steps dropped under 6x throttle').toBe(0);
});
