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
  // Measure the window on BOTH clocks. The sequencer is driven by the audio clock, so its step
  // count is checked against the audio time that actually elapsed (see the check below).
  const w0 = await page.evaluate(() => ({ wall: performance.now(), ac: audioCtx.currentTime, steps: __qa.wrapped.step, bpm, n: __qa.steps.length }));
  await page.waitForTimeout(10_000);
  const w1 = await page.evaluate(() => ({ wall: performance.now(), ac: audioCtx.currentTime, steps: __qa.wrapped.step, bpm }));
  const r = await page.evaluate(() => ({ state, stage, bpm, music: { on: music.on, step: music.step, bar: music.bar },
    wrapped: __qa.wrapped, notes: __qa.notes.length, steps: __qa.steps.length, misses: runStats.misses,
    ac: audioCtx.state, sampleRate: audioCtx.sampleRate, baseLatency: audioCtx.baseLatency, outputLatency: audioCtx.outputLatency }));
  writeResult('smoke-run', { r, errors });
  console.log('smoke-run ' + JSON.stringify({ state: r.state, steps: r.wrapped.step, notes: r.wrapped.note, ac: r.ac,
    pauses: await page.evaluate(() => (typeof _t6PauseCount === 'number' ? _t6PauseCount : null)) }));
  // Sequencer check, against the audio clock (was: wall-clock floor `steps > 30`).
  // CI WebKit advances its audio clock slower than real time, so a wall-clock floor flakes there
  // (28-35 steps per 10 s on CI vs ~49 on Chromium/Firefox) while not catching a sequencer that keeps
  // up with wall time but drops steps. Now: every 16th-step the audio clock covered must have been
  // scheduled, within ±10%. Dropped/late steps (reanchor skips, steps behind the clock) still fail.
  const wallS = (w1.wall - w0.wall) / 1000, audioS = w1.ac - w0.ac, stepsIn = w1.steps - w0.steps;
  // Expected count = audio seconds / the step length the game itself used (tempo can step mid-window).
  const win = (await page.evaluate(() => __qa.steps)).slice(w0.n);
  const avgDur = win.length ? win.reduce((a, x) => a + x.stepDur, 0) / win.length : (60 / w0.bpm) / 4;
  const lo = 0.9 * audioS / avgDur, hi = 1.1 * audioS / avgDur;
  let gaps = 0; for (let i = 1; i < win.length; i++) if (win[i].when - win[i - 1].when > 1.5 * win[i - 1].stepDur) gaps++;
  const clocks = { wallS: +wallS.toFixed(2), audioS: +audioS.toFixed(2), audioPerWall: +(audioS / wallS).toFixed(3),
    steps: stepsIn, expected: [+lo.toFixed(1), +hi.toFixed(1)], gaps, bpm: [w0.bpm, w1.bpm] };
  console.log('smoke-clocks ' + JSON.stringify(clocks));
  expect(r.wrapped.step).toBeGreaterThan(0);                   // probes really intercept internal calls
  // Audio clock must keep near real time. Chromium/Firefox: >= 0.9x wall. WebKit gets >= 0.5x: its
  // headless Linux build is the one that lags on CI; a stalled or suspended context still fails.
  const minRate = browserName === 'webkit' ? 0.5 : 0.9;
  expect(audioS, 'audio clock vs wall: ' + JSON.stringify(clocks)).toBeGreaterThanOrEqual(minRate * wallS);
  expect(stepsIn, 'steps vs audio clock: ' + JSON.stringify(clocks)).toBeGreaterThanOrEqual(lo);
  expect(stepsIn, 'steps vs audio clock: ' + JSON.stringify(clocks)).toBeLessThanOrEqual(hi);
  expect(r.wrapped.note).toBeGreaterThan(3);
  // the 10 s snapshot can land on the ~1 s LEVEL banner, which is still a live run
  expect(['playing', 'levelup']).toContain(r.state);
  expect(errors, errors.join('\n')).toEqual([]);
});
