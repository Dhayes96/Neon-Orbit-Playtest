const { test, expect } = require('@playwright/test');
const { boot, installProbes, startBot, writeResult } = require('./harness');

test('mobile (Pixel 7 emulation): touch start, phone anchors, single tap counts once', async ({ page }) => {
  const errors = await boot(page);
  await installProbes(page);
  await page.locator('#startBtn').tap();
  await page.waitForFunction(() => state === 'playing');
  await page.waitForFunction(() => audioCtx && audioCtx.state === 'running' && music.on, null, { timeout: 5000 });
  const geo = await page.evaluate(() => ({ W, H, DPR, targetR, anchors: anchors.map((a) => a.id), coarse: matchMedia('(pointer: coarse)').matches }));
  // One physical tap on the target: must increment runStats.taps exactly once (pointerdown + touch dedupe).
  const t0 = await page.evaluate(() => runStats.taps);
  await page.touchscreen.tap(Math.round(geo.W / 2), Math.round(geo.H / 2));
  await page.waitForTimeout(200);
  const t1 = await page.evaluate(() => runStats.taps);
  await startBot(page);
  await page.waitForTimeout(8000);
  const end = await page.evaluate(() => ({ state, misses: runStats.misses, hits: runStats.hits }));
  writeResult('mobile-pixel7', { geo, tapsCounted: t1 - t0, end, errors });
  expect(t1 - t0).toBe(1);
  expect(geo.anchors).not.toContain('UL'); // phone comfort zone: no upper row
  expect(errors).toEqual([]);
});
