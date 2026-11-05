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
  expect(gaps, 'grid gaps (dropped steps) under jank: ' + JSON.stringify(res)).toBeLessThanOrEqual(1); // was 2; the 500 ms start headroom now covers the first stall (0 seen locally), 1 allowed for a loaded box
  expect(w1.ahead, 'lookahead grew to cover the stall').toBeGreaterThan(0.3);
  expect(w1.ahead).toBeLessThanOrEqual(settled.max);
  // Back near the 140 ms floor: one ordinary ~90 ms headless timer gap legitimately re-raises it to
  // gap + 50 ms, so "near" is floor + 60 ms, well under the 300+ ms it reached during the jank.
  expect(settled.ahead, 'lookahead back near its floor after the jank stops').toBeLessThanOrEqual(settled.min + 0.06);
  expect(settled.ahead).toBeGreaterThanOrEqual(settled.min);
  expect(errors, errors.join('\n')).toEqual([]);
});

// T7: the first seconds of a run are the jankiest (CI WebKit stalled 461 ms right after start and
// dropped 3 steps before the lookahead could adapt). Each run now starts with 500 ms of headroom,
// so one 450 ms stall just after start drops nothing. Fails with a 140 ms starting lookahead.
test('T7: a single 450 ms stall right after the run starts drops no steps', async ({ page }) => {
  const errors = await boot(page);
  await installProbes(page);
  await page.click('#startBtn');
  await page.waitForFunction(() => state === 'playing');
  await page.waitForFunction(() => audioCtx && audioCtx.state === 'running' && music.on, null, { timeout: 5000 });
  const n0 = await page.evaluate(() => __qa.steps.length);
  await page.evaluate(() => { const t = performance.now(); while (performance.now() - t < 450) {} });
  await page.waitForTimeout(1500);
  const r = await page.evaluate((n0) => {
    const w = __qa.steps.slice(Math.max(0, n0 - 1)); let gaps = 0;
    for (let i = 1; i < w.length; i++) if (w[i].when - w[i - 1].when > 1.5 * w[i - 1].stepDur) gaps++;
    return { gaps, steps: w.length, ahead: musicAhead };
  }, n0);
  console.log('t7-start-stall ' + JSON.stringify(r));
  expect(r.steps, 'steps scheduled after the stall').toBeGreaterThan(4);
  expect(r.gaps, 'grid gaps (dropped steps) after a 450 ms start-of-run stall: ' + JSON.stringify(r)).toBe(0);
  expect(errors, errors.join('\n')).toEqual([]);
});
