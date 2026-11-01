const { test, expect } = require('@playwright/test');
const { boot, installProbes, startBot, stats, writeResult } = require('./harness');
// musicBeatPhase() (line ~2846) drives visual beat pulses. Compare it to the
// beat phase reconstructed from the steps actually scheduled on the audio clock.
test('visual beat phase vs audible beat phase', async ({ page }) => {
  const errors = await boot(page);
  await installProbes(page);
  await page.click('#startBtn');
  await page.waitForFunction(() => state === 'playing' && audioCtx && audioCtx.state === 'running' && music.on);
  await startBot(page);
  await page.waitForTimeout(3000);
  const errs = await page.evaluate(async () => {
    const out = [];
    for (let i = 0; i < 300; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const now = audioCtx.currentTime; let last = null;
      for (let j = __qa.steps.length - 1; j >= 0; j--) if (__qa.steps[j].when <= now) { last = __qa.steps[j]; break; }
      if (!last) continue;
      const truth = (((last.step % 4) + (now - last.when) / last.stepDur) / 4) % 1;
      const shown = musicBeatPhase();
      let d = shown - truth; if (d > 0.5) d -= 1; if (d < -0.5) d += 1;
      out.push(d * (60 / bpm) * 1000); // ms; positive = visuals ahead of audio
    }
    return out;
  });
  const result = { visualLeadMs: stats(errs), errors };
  writeResult('visual-phase', result);
  expect.soft(Math.abs(result.visualLeadMs.p50), 'visual beat phase offset (ms)').toBeLessThan(10);
});
