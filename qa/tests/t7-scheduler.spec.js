const { test, expect } = require('@playwright/test');
const { boot, installProbes, startBot, writeResult } = require('./harness');

// T7 (RV-14): scheduler headroom. With a fixed 140 ms lookahead, a 25 ms timer that fires
// ~300 ms late dropped every step due inside the gap, so the music stuttered on janky devices
// (seen on starved CI WebKit: 27-34 of ~50 steps scheduled). The lookahead now adapts to the
// worst recent timer gap. This test makes the jank on purpose (a 300 ms main-thread block every
// 700 ms) so it reproduces on any engine, then checks that every step the audio clock covered was
// scheduled (±10%), on the grid, and that the lookahead returns to 140 ms once the jank stops.
// Fails on the old build: about 1-2 steps dropped per block.
test('T7: steps keep up with the audio clock through repeated 300 ms main-thread stalls', async ({ page }) => {
  const errors = await boot(page);
  await installProbes(page);
  await page.click('#startBtn');
  await page.waitForFunction(() => state === 'playing');
  await page.waitForFunction(() => audioCtx && audioCtx.state === 'running' && music.on, null, { timeout: 5000 });
  await startBot(page);
  const w0 = await page.evaluate(() => {
    window.__jank = setInterval(() => { const t = performance.now(); while (performance.now() - t < 300) {} }, 700);
    return { wall: performance.now(), ac: audioCtx.currentTime, steps: __qa.wrapped.step, n: __qa.steps.length };
  });
  await page.waitForTimeout(8000);
  const w1 = await page.evaluate(() => { clearInterval(window.__jank);
    return { wall: performance.now(), ac: audioCtx.currentTime, steps: __qa.wrapped.step, ahead: musicAhead, state }; });
  const win = (await page.evaluate(() => __qa.steps)).slice(w0.n);
  const audioS = w1.ac - w0.ac, stepsIn = w1.steps - w0.steps;
  const avgDur = win.reduce((a, x) => a + x.stepDur, 0) / Math.max(1, win.length);
  const lo = 0.9 * audioS / avgDur, hi = 1.1 * audioS / avgDur;
  let gaps = 0; for (let i = 1; i < win.length; i++) if (win[i].when - win[i - 1].when > 1.5 * win[i - 1].stepDur) gaps++;
  // After the jank stops, the lookahead must decay back to the 140 ms floor (no permanent latency).
  await page.waitForTimeout(6000);
  const settled = await page.evaluate(() => ({ ahead: musicAhead, min: MUSIC_AHEAD_MIN, max: MUSIC_AHEAD_MAX }));
  const res = { audioS: +audioS.toFixed(2), wallS: +((w1.wall - w0.wall) / 1000).toFixed(2), steps: stepsIn,
    expected: [+lo.toFixed(1), +hi.toFixed(1)], gaps, aheadDuringJank: +w1.ahead.toFixed(3), aheadSettled: +settled.ahead.toFixed(3), state: w1.state };
  writeResult('t7-scheduler', { res, errors });
  console.log('t7-scheduler ' + JSON.stringify(res));
  expect(stepsIn, 'steps vs audio clock under jank: ' + JSON.stringify(res)).toBeGreaterThanOrEqual(lo);
  expect(stepsIn, 'steps vs audio clock under jank: ' + JSON.stringify(res)).toBeLessThanOrEqual(hi);
  expect(gaps, 'grid gaps (dropped steps) under jank: ' + JSON.stringify(res)).toBeLessThanOrEqual(2); // only the first stall, before the lookahead adapts
  expect(w1.ahead, 'lookahead grew to cover the stall').toBeGreaterThan(0.3);
  expect(w1.ahead).toBeLessThanOrEqual(settled.max);
  expect(settled.ahead, 'lookahead back at its floor after the jank stops').toBeCloseTo(settled.min, 3);
  expect(errors, errors.join('\n')).toEqual([]);
});
