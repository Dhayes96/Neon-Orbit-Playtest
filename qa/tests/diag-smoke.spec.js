// DIAG ONLY (never merge): why CI WebKit counts ~30 sequencer steps in 10 s where Chromium counts ~50.
const { test } = require('@playwright/test');
const { boot, installProbes, startBot } = require('./harness');

test('diag: smoke run clocks', async ({ page, browserName }) => {
  await page.addInitScript(() => {
    const d = window.__diag = { ticks: [], reanchors: 0, adv: 0, sched: 0 };
    const si = window.setInterval;
    window.setInterval = function (fn, ms, ...rest) {
      if (ms === 25 && fn && fn.name === 'musicTick') {
        const wrapped = function () {
          const t = performance.now();
          const s0 = (typeof music !== 'undefined') ? music.step + 16 * music.bar : 0;
          const r = fn.apply(this, arguments);
          if (typeof music !== 'undefined') { const s1 = music.step + 16 * music.bar; d.adv += (s1 - s0 + 64) % 64; }
          d.ticks.push(t);
          return r;
        };
        return si.call(this, wrapped, ms, ...rest);
      }
      return si.call(this, fn, ms, ...rest);
    };
  });
  const errors = await boot(page);
  await installProbes(page);
  await page.evaluate(() => { const o = reanchorMusicGrid; window.reanchorMusicGrid = function () { window.__diag.reanchors++; return o.apply(this, arguments); }; });
  await page.click('#startBtn');
  await page.waitForFunction(() => state === 'playing');
  await page.waitForFunction(() => audioCtx && audioCtx.state === 'running' && music.on, null, { timeout: 15000 });
  await startBot(page);
  const a = await page.evaluate(() => ({ wall: performance.now(), ac: audioCtx.currentTime, steps: __qa.wrapped.step, adv: __diag.adv, ticks: __diag.ticks.length,
    levelSamples: 0 }));
  // sample state every 100 ms to measure time spent in levelup
  await page.evaluate(() => { window.__lv = { lv: 0, n: 0 }; window.__lvT = setInterval(() => { __lv.n++; if (state === 'levelup') __lv.lv++; }, 100); });
  await page.waitForTimeout(10_000);
  const b = await page.evaluate(() => {
    const t = __diag.ticks; const gaps = []; for (let i = 1; i < t.length; i++) gaps.push(t[i] - t[i - 1]);
    gaps.sort((x, y) => x - y);
    const q = (p) => gaps.length ? +gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))].toFixed(1) : null;
    const frames = __qa.frames.slice(-600).slice().sort((x, y) => x - y);
    const fq = (p) => frames.length ? +frames[Math.min(frames.length - 1, Math.floor(p * frames.length))].toFixed(1) : null;
    return { wall: performance.now(), ac: audioCtx.currentTime, steps: __qa.wrapped.step, adv: __diag.adv, ticks: __diag.ticks.length,
      tickGap: { p50: q(0.5), p90: q(0.9), p99: q(0.99), max: q(1), over100: gaps.filter((g) => g > 100).length },
      frame: { p50: fq(0.5), p90: fq(0.9), max: fq(1) }, reanchors: __diag.reanchors, bpm, stage, state,
      levelupFrac: +(__lv.lv / Math.max(1, __lv.n)).toFixed(2), longTasks: (window.__longTasks || []).length,
      sampleRate: audioCtx.sampleRate, baseLatency: audioCtx.baseLatency };
  });
  const wallS = (b.wall - a.wall) / 1000, acS = b.ac - a.ac;
  const expected = acS * (b.bpm / 60) * 4;
  console.log('DIAGJSON ' + JSON.stringify({ browserName, wallS: +wallS.toFixed(2), audioS: +acS.toFixed(2), audioPerWall: +(acS / wallS).toFixed(3),
    stepsScheduled: b.steps - a.steps, stepsAdvanced: b.adv - a.adv, dropped: (b.adv - a.adv) - (b.steps - a.steps), expectedFromAudio: +expected.toFixed(1),
    ticks: b.ticks - a.ticks, tickGap: b.tickGap, frame: b.frame, reanchors: b.reanchors, bpm: b.bpm, stage: b.stage, state: b.state,
    levelupFrac: b.levelupFrac, longTasks: b.longTasks, sampleRate: b.sampleRate, errors: errors.length }));
});
