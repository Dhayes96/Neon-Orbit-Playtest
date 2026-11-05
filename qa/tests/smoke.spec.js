const { test, expect } = require('@playwright/test');
const { boot, installProbes, startBot, writeResult } = require('./harness');

test('boot: loads headless with no console/page errors and a live render loop', async ({ page }) => {
  const errors = await boot(page);
  await expect(page.locator('#startBtn')).toBeVisible();
  const info = await page.evaluate(async () => {
    const f0 = await new Promise((r) => { let n = 0; const s = performance.now(); (function k() { if (++n === 30) r(performance.now() - s); else requestAnimationFrame(k); })(); });
    return { VERSION, state, ms30frames: f0, canvas: !!document.querySelector('canvas'), audioCtx: !!audioCtx };
  });
  expect(info.state).toBe('menu');
  expect(info.canvas).toBe(true);
  expect(info.audioCtx).toBe(false); // AudioContext must not exist before a gesture (autoplay policy)
  writeResult('smoke-boot', { info, errors });
  expect(errors, errors.join('\n')).toEqual([]);
});

test('start run: real click starts audio + sequencer + note spawning, 10s with no errors', async ({ page, browserName }) => {
  const errors = await boot(page);
  await installProbes(page);
  await page.click('#startBtn');
  await page.waitForFunction(() => state === 'playing');
  // Firefox on a CI runner (PulseAudio null sink) sometimes needs >5 s to bring its AudioContext up.
  const audioTimeout = browserName === 'firefox' ? 15000 : 5000;
  await page.waitForFunction(() => audioCtx && audioCtx.state === 'running' && music.on, null, { timeout: audioTimeout });
  await startBot(page); // without a player the run correctly ends in ~10s (energy drain + auto-miss)
  const stepsAtStart = await page.evaluate(() => __qa.steps.length);
  await page.waitForTimeout(10_000);
  // T7 (RV-14): beats the sequencer skipped because its timer fired later than the lookahead window.
  // An index gap between consecutive scheduled steps is a dropped (silent) beat; a re-anchor keeps
  // the index contiguous and is not counted here.
  const dropped = await page.evaluate((k) => {
    const s = __qa.steps.slice(Math.max(1, k) - 1); let n = 0;
    for (let i = 1; i < s.length; i++) n += ((s[i].step - s[i - 1].step + 16) % 16) - 1;
    return n;
  }, stepsAtStart);
  const r = await page.evaluate(() => ({ state, stage, bpm, music: { on: music.on, step: music.step, bar: music.bar },
    wrapped: __qa.wrapped, notes: __qa.notes.length, steps: __qa.steps.length, misses: runStats.misses,
    ac: audioCtx.state, sampleRate: audioCtx.sampleRate, baseLatency: audioCtx.baseLatency, outputLatency: audioCtx.outputLatency }));
  writeResult('smoke-run', { r, errors });
  console.log('smoke-run ' + JSON.stringify({ state: r.state, steps: r.wrapped.step, notes: r.wrapped.note, ac: r.ac, dropped,
    pauses: await page.evaluate(() => (typeof _t6PauseCount === 'number' ? _t6PauseCount : null)) }));
  expect(r.wrapped.step).toBeGreaterThan(30);    // ~49 16th-steps in 10s @74 BPM: probes really intercept internal calls
  expect(r.wrapped.note).toBeGreaterThan(3);
  // New (T7): at most 1 silent beat in 10 s, allowing for the window adapting to a sudden stall.
  expect(dropped, 'music steps dropped (silent beats) in 10 s').toBeLessThanOrEqual(1);
  // the 10 s snapshot can land on the ~1 s LEVEL banner, which is still a live run
  expect(['playing', 'levelup']).toContain(r.state);
  expect(errors, errors.join('\n')).toEqual([]);
});
