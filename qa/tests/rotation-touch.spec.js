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

// ---- Pause/Resume after rotation (Dennel, real iPhone: Pause didn't respond after going landscape)
async function iphoneRun(browser) {
  const { defaultBrowserType, ...dev } = devices['iPhone 13'];
  const ctx = await browser.newContext({ ...dev, viewport: PORTRAIT });
  const page = await ctx.newPage();
  const errors = await boot(page);
  await page.click('#startBtn');
  await page.waitForFunction(() => state === 'playing');
  return { ctx, page, errors };
}
const centre = (page, sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; }, sel);
async function tapPauseThenResume(page, label) {
  const p = await centre(page, '#pauseBtn');
  expect(p.w, `${label}: pause button visible`).toBeGreaterThan(0);
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y).id, p), `${label}: nothing covers Pause`).toBe('pauseBtn');
  await page.touchscreen.tap(p.x, p.y);
  await expect.poll(() => page.evaluate(() => state), { message: `${label}: tap pauses`, timeout: 1000 }).toBe('paused');
  const r = await centre(page, '#pauseResumeBtn');
  await page.touchscreen.tap(r.x, r.y);
  await page.waitForFunction(() => state === 'playing', null, { timeout: 8000 });
}

for (const variant of ['clean', 'stale']) {
  test(`rotation (${variant}): Pause and Resume respond to a tap in landscape and back in portrait`, async ({ browser }) => {
    const { ctx, page, errors } = await iphoneRun(browser);
    await page.waitForTimeout(1500);
    await tapPauseThenResume(page, 'portrait');
    for (const [label, size, from] of [['landscape', LANDSCAPE, PORTRAIT], ['portrait again', PORTRAIT, LANDSCAPE]]) {
      if (variant === 'stale') await staleSize(page, from);
      await page.setViewportSize(size);
      if (variant === 'stale') { await page.waitForTimeout(300); await releaseSize(page); }
      await page.waitForTimeout(1200);
      await tapPauseThenResume(page, label);
    }
    await ctx.close();
    expect(errors).toEqual([]);
  });
}

test('Pause works on touch-down alone and Resume on touchend alone (iOS dropping the click)', async ({ browser }) => {
  const { ctx, page, errors } = await iphoneRun(browser);
  await page.setViewportSize(LANDSCAPE);
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.getElementById('pauseBtn').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', isPrimary: true })));
  expect(await page.evaluate(() => state), 'pointerdown alone pauses').toBe('paused');
  await page.evaluate(() => document.getElementById('pauseResumeBtn').dispatchEvent(new Event('touchend', { bubbles: true })));
  await page.waitForFunction(() => state === 'playing', null, { timeout: 8000 });
  await ctx.close();
  expect(errors).toEqual([]);
});

test('safety net: a rotation that fires no resize events is still picked up, and a scrolled page snaps back', async ({ browser }) => {
  const { ctx, page, errors } = await iphoneRun(browser);
  await page.waitForTimeout(800);
  // The browser reports the OLD size through the whole rotation and well past the ~1 s settle
  // window, then the real size appears with no event at all. Only the loop safety net sees it.
  await staleSize(page, PORTRAIT);
  await page.setViewportSize(LANDSCAPE);
  await page.waitForTimeout(1600);
  expect(await page.evaluate(() => [W, H]), 'precondition: layout still stale').toEqual([PORTRAIT.width, PORTRAIT.height]);
  await releaseSize(page);                                 // real size now visible, no event fired
  await expect.poll(() => page.evaluate(() => [W, H]), { message: 'layout catches up without events', timeout: 1500 }).toEqual([LANDSCAPE.width, LANDSCAPE.height]);
  // iOS can leave the document scrolled after a rotation; fixed UI is then hit-tested off its drawing.
  const scrolled = await page.evaluate(() => { document.body.style.height = '3000px'; window.scrollTo(0, 120); return window.scrollY; });
  expect(scrolled, 'precondition: page actually scrolled').toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.scrollY), { message: 'scroll snapped back', timeout: 1500 }).toBe(0);
  await page.evaluate(() => { document.body.style.height = ''; });
  await ctx.close();
  expect(errors).toEqual([]);
});
