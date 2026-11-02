// iPhone rotation: portrait -> landscape -> portrait must leave every ring tappable where it is
// drawn. A bot taps each ring at its drawn position through real hit-testing (elementFromPoint),
// so overlays, off-screen rings or a stale layout all show up as failures.
// The "stale" variant mimics iOS Safari reporting the old innerWidth/innerHeight for ~300 ms
// during the rotation, with no further resize event once it settles.
const { test, expect, devices } = require('@playwright/test');
const { boot, installProbes, writeResult } = require('./harness');

const PORTRAIT = { width: 390, height: 664 }, LANDSCAPE = { width: 750, height: 340 };

async function positionalBot(page) {
  await page.evaluate(() => {
    window.__ph = 'P1'; window.__log = {};
    function tick() {
      if (state === 'playing' || state === 'bossBattle') {
        const t = clockNow() - startTime;
        for (const n of notes) {
          if (n.hit || n.missed || n.__b) continue;
          if (t < n.hitTime + audioOffset()) continue;
          n.__b = true;
          const L = (window.__log[__ph] ||= { taps: 0, hit: 0, off: 0, miss: 0, offscreen: 0, notCanvas: 0, zoned: 0 });
          L.taps++;
          const onScreen = n.tx >= 0 && n.ty >= 0 && n.tx < innerWidth && n.ty < innerHeight;
          if (!onScreen) { L.offscreen++; break; }       // a finger can't reach it: that's the bug
          const el = document.elementFromPoint(n.tx, n.ty);
          if (el !== canvas) { L.notCanvas++; break; }
          if (tapZoneRadius() > 0) L.zoned++;
          const b = { h: runStats.hits, o: runStats.offTarget, m: runStats.misses };
          el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: n.tx, clientY: n.ty, pointerType: 'touch', isPrimary: true }));
          if (runStats.hits > b.h) L.hit++; else if (runStats.offTarget > b.o) L.off++; else if (runStats.misses > b.m) L.miss++;
          break;
        }
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
}
// Make innerWidth/innerHeight report `size` until released (iOS mid-rotation behaviour).
const staleSize = (page, size) => page.evaluate(({ width, height }) => {
  window.__realIW = Object.getOwnPropertyDescriptor(window, 'innerWidth');
  window.__realIH = Object.getOwnPropertyDescriptor(window, 'innerHeight');
  Object.defineProperty(window, 'innerWidth', { configurable: true, get: () => width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => height });
}, size);
const releaseSize = (page) => page.evaluate(() => {
  Object.defineProperty(window, 'innerWidth', window.__realIW);
  Object.defineProperty(window, 'innerHeight', window.__realIH);
});

for (const variant of ['clean', 'stale']) {
  test(`rotation (${variant}): portrait -> landscape -> portrait keeps every ring tappable where drawn`, async ({ browser }) => {
    const { defaultBrowserType, ...dev } = devices['iPhone 13'];
    const ctx = await browser.newContext({ ...dev, viewport: PORTRAIT });
    const page = await ctx.newPage();
    const errors = await boot(page); await installProbes(page);
    await page.click('#startBtn');
    await page.waitForFunction(() => state === 'playing');
    await positionalBot(page);
    await page.waitForTimeout(9000);                      // reach a stage with a tap zone
    await page.evaluate(() => (__ph = 'L'));
    if (variant === 'stale') await staleSize(page, PORTRAIT);
    await page.setViewportSize(LANDSCAPE);
    if (variant === 'stale') { await page.waitForTimeout(300); await releaseSize(page); }
    await page.waitForTimeout(6000);
    await page.evaluate(() => (__ph = 'P2'));
    if (variant === 'stale') await staleSize(page, LANDSCAPE);
    await page.setViewportSize(PORTRAIT);
    if (variant === 'stale') { await page.waitForTimeout(300); await releaseSize(page); }
    await page.waitForTimeout(9000);
    const geo = await page.evaluate(() => ({ W, H, iw: innerWidth, ih: innerHeight, rect: canvas.getBoundingClientRect().toJSON(), stage }));
    const log = await page.evaluate(() => __log);
    writeResult(`rotation-touch-${variant}`, { geo, log, errors });
    await ctx.close();
    expect(errors).toEqual([]);
    expect({ W: geo.W, H: geo.H }, 'layout matches the real screen once rotation settles').toEqual({ W: geo.iw, H: geo.ih });
    for (const ph of ['L', 'P2']) {
      const L = log[ph];
      expect(L && L.taps, `${ph}: rings arrived`).toBeGreaterThanOrEqual(3);
      expect(L.offscreen, `${ph}: rings landing off-screen`).toBe(0);
      expect(L.notCanvas, `${ph}: rings covered by UI`).toBe(0);
      expect(L.off + L.miss, `${ph}: taps on the drawn ring that did not register`).toBe(0);
    }
    expect(log.P2.zoned, 'tap-zone stages were exercised after rotating back').toBeGreaterThan(0);
  });
}
