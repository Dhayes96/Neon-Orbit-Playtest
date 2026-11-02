// CrazyGames Basic Launch (c): iPhone audio start/unlock. CrazyGames' technical requirements say
// AudioContext.resume() must be called inside a touchend or click gesture (a visibility listener
// alone is not enough). Emulated iPhone 13 (touch); runs on Chromium locally and on WebKit in CI.
// Synthetic events carry no user activation, so the resume() *call* is asserted on every engine
// and the resulting 'running' state on Chromium (autoplay flag) only. Real iPhone = Dennel.
const { test, expect, devices } = require('@playwright/test');
const { boot, installProbes, writeResult } = require('./harness');

async function iphone(browser) {
  const { defaultBrowserType, ...dev } = devices['iPhone 13'];
  const ctx = await browser.newContext(dev);
  return { ctx, page: await ctx.newPage() };
}
const fire = (page, type) => page.evaluate((t) => {
  const ev = t === 'click' ? new MouseEvent('click', { bubbles: true, cancelable: true }) : new Event(t, { bubbles: true });
  document.body.dispatchEvent(ev);
}, type);
const spyResume = (page) => page.evaluate(() => {
  window.__resumeCalls = 0;
  const real = audioCtx.resume.bind(audioCtx);
  audioCtx.resume = () => { window.__resumeCalls++; return real(); };
});

for (const type of ['touchend', 'click']) {
  test(`iPhone: a ${type} alone unlocks audio on a fresh page`, async ({ browser, browserName }) => {
    const { ctx, page } = await iphone(browser);
    const errors = await boot(page);
    const before = await page.evaluate(() => !!audioCtx);
    await fire(page, type);                 // no pointerdown / keydown at all
    await page.waitForTimeout(800);
    const after = await page.evaluate(() => ({ exists: !!audioCtx, state: audioCtx && audioCtx.state }));
    writeResult(`cg-audio-first-${type}-${browserName}`, { before, after, errors });
    await ctx.close();
    expect(errors).toEqual([]);
    expect(before, 'no AudioContext before a gesture').toBe(false);
    expect(after.exists, `${type} creates the AudioContext`).toBe(true);
    if (browserName === 'chromium') expect(after.state).toBe('running');
  });
}

test('iPhone: audio interrupted mid-run → run auto-pauses; touchend resumes audio but NOT the run; Resume restarts play', async ({ browser, browserName }) => {
  const { ctx, page } = await iphone(browser);
  const errors = await boot(page);
  await installProbes(page);
  await page.locator('#startBtn').tap();
  await page.waitForFunction(() => state === 'playing' && audioCtx && audioCtx.state === 'running', null, { timeout: 8000 });
  await page.waitForTimeout(3000);
  await spyResume(page);
  // idempotent while running: taps do not call resume()
  await fire(page, 'touchend'); await fire(page, 'click');
  const callsWhileRunning = await page.evaluate(() => window.__resumeCalls);
  // interruption: the context is suspended (as iOS does) → the run auto-pauses
  await page.evaluate(() => audioCtx.suspend());
  await page.waitForFunction(() => state === 'paused', null, { timeout: 4000 });
  const pausedReason = await page.evaluate(() => pauseInfo && pauseInfo.reason);
  await page.evaluate(() => { window.__resumeCalls = 0; });
  await fire(page, 'touchend');           // the documented iOS fix
  await page.waitForTimeout(600);
  const afterTouch = await page.evaluate(() => ({ calls: window.__resumeCalls, ac: audioCtx.state, state }));
  // only the Resume button restarts the run (3-2-1)
  await page.locator('#pauseResumeBtn').tap();
  await page.waitForFunction(() => state === 'playing', null, { timeout: 8000 });
  const n0 = await page.evaluate(() => __qa.notes.length);
  await page.waitForTimeout(4000);
  const end = await page.evaluate((i) => ({ state, ac: audioCtx.state, newRings: __qa.notes.length - i }), n0);
  const res = { callsWhileRunning, pausedReason, afterTouch, end, errors };
  writeResult(`cg-audio-midrun-${browserName}`, res);
  await ctx.close();
  expect(errors).toEqual([]);
  expect(callsWhileRunning, 'no resume() calls while audio is running').toBe(0);
  expect(pausedReason).toBe('audio');
  expect(afterTouch.calls, 'touchend calls resume()').toBeGreaterThanOrEqual(1);
  expect(afterTouch.state, 'a tap never un-pauses the run').toBe('paused');
  if (browserName === 'chromium') expect(afterTouch.ac).toBe('running');
  expect(end.state).toBe('playing');
  expect(end.newRings, 'rings resume after Resume').toBeGreaterThanOrEqual(2);
});
