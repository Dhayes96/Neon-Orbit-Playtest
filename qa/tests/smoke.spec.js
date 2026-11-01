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

test('start run: real click starts audio + sequencer + note spawning, 10s with no errors', async ({ page }) => {
  const errors = await boot(page);
  await installProbes(page);
  await page.click('#startBtn');
  await page.waitForFunction(() => state === 'playing');
  await page.waitForFunction(() => audioCtx && audioCtx.state === 'running' && music.on, null, { timeout: 5000 });
  await startBot(page); // without a player the run correctly ends in ~10s (energy drain + auto-miss)
  await page.waitForTimeout(10_000);
  const r = await page.evaluate(() => ({ state, stage, bpm, music: { on: music.on, step: music.step, bar: music.bar },
    wrapped: __qa.wrapped, notes: __qa.notes.length, steps: __qa.steps.length, misses: runStats.misses,
    ac: audioCtx.state, sampleRate: audioCtx.sampleRate, baseLatency: audioCtx.baseLatency, outputLatency: audioCtx.outputLatency }));
  writeResult('smoke-run', { r, errors });
  expect(r.wrapped.step).toBeGreaterThan(30);    // ~49 16th-steps in 10s @74 BPM: probes really intercept internal calls
  expect(r.wrapped.note).toBeGreaterThan(3);
  // the 10 s snapshot can land on the ~1 s LEVEL banner, which is still a live run
  expect(['playing', 'levelup']).toContain(r.state);
  expect(errors, errors.join('\n')).toEqual([]);
});
