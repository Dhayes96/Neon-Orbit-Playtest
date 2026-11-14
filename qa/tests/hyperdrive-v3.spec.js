// Hyperdrive v3 (Nov 13, Dennel): one-handed on a phone (slide to steer, tap to fire; keys and
// mouse unchanged), 30 seconds instead of 60, a first-flight controls card that freezes time until
// Continue (once; Reset Tutorial brings it back), and the new space-time tunnel and black hole.
const { test, expect } = require('@playwright/test');
const { boot } = require('./harness');

const fxErrors = (errors) => errors.filter((e) => /\[fx\]|Maximum call stack|RangeError|TypeError|ReferenceError/.test(e));
const lit = (page) => page.evaluate(() => {
  const c = document.getElementById('game') || document.querySelector('canvas'), g = c.getContext('2d');
  const d = g.getImageData(0, 0, c.width, c.height).data; let on = 0, n = 0;
  for (let y = Math.floor(c.height * 0.1); y < c.height * 0.9; y += 12) for (let x = 0; x < c.width; x += 12) { const i = (y * c.width + x) * 4; n++; if (d[i] + d[i + 1] + d[i + 2] > 60) on++; }
  return on / n;
});
const gameT = (page) => page.evaluate(() => (state === 'paused' && pauseInfo ? pauseInfo.at : clockNow()) - startTime);

async function startRun(page, tap) {
  if (tap) await page.tap('#startBtn'); else await page.click('#startBtn');
  await page.waitForFunction(() => state === 'playing' && audioCtx && audioCtx.state === 'running', null, { timeout: 10000 });
  await page.waitForTimeout(800);
}

test('first flight: the controls card freezes time and the music until Continue, shows once, and Reset Tutorial brings it back', async ({ page }) => {
  test.setTimeout(90000);
  const errors = await boot(page, { save: { level: 60 } });
  expect(await page.evaluate(() => save.hyperTutDone)).toBe(false);
  await startRun(page, false);
  await page.evaluate(() => Hyper.request());
  await page.waitForFunction(() => Hyper.cardOpen, null, { timeout: 10000 });
  const a = await page.evaluate(() => ({
    state, from: pauseInfo && pauseInfo.from, reason: pauseInfo && pauseInfo.reason,
    card: !document.getElementById('hyperCard').classList.contains('hidden'),
    pauseScreen: document.getElementById('pauseOverlay').classList.contains('show'),
    keys: document.getElementById('hyperCard').classList.contains('keys'),
    rows: document.querySelector('#hyperCard .hc-rows').innerText, foot: document.querySelector('#hyperCard .hc-foot').innerText,
    stats: JSON.stringify(Hyper.stats), music: music.paused === true || music._paused === true || musicGain.gain.value < 0.02,
  }));
  expect(a).toMatchObject({ state: 'paused', from: 'playing', reason: 'hypertut', card: true, pauseScreen: false, keys: true });
  expect(a.rows).toMatch(/A \/ D/); expect(a.rows).toMatch(/SPACE/);
  expect(a.foot).toMatch(/30 seconds/);
  const t1 = await gameT(page), c1 = await page.evaluate(() => Hyper.course.map((o) => o.arrive).join());
  await page.waitForTimeout(2000);
  expect(await gameT(page), 'game time stands still behind the card').toBe(t1);
  expect(await page.evaluate(() => Hyper.course.map((o) => o.arrive).join()), 'the course does not move').toBe(c1);
  expect(await page.evaluate(() => JSON.stringify(Hyper.stats)), 'nothing is scored or crashed while it waits').toBe(a.stats);
  // Continue (Enter), through the 3-2-1, and the flight picks up exactly where it stopped
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => state === 'playing', null, { timeout: 10000 });
  const b = await page.evaluate(() => ({ card: !document.getElementById('hyperCard').classList.contains('hidden'), done: save.hyperTutDone, saved: JSON.parse(localStorage.getItem('rhythmVoidSave.v1')).hyperTutDone }));
  expect(b).toEqual({ card: false, done: true, saved: true });
  expect(await gameT(page) - t1, 'the flight resumed from the frozen moment').toBeLessThan(1.2);
  // a second flight: no card
  await page.evaluate(() => { Hyper.cancel(); Hyper.request(); });
  await page.waitForFunction(() => Hyper.active, null, { timeout: 5000 });
  await page.waitForTimeout(3000);
  expect(await page.evaluate(() => ({ open: Hyper.cardOpen, state }))).toEqual({ open: false, state: 'playing' });
  // Reset Tutorial (Settings) brings the card back for the next flight
  await page.evaluate(() => document.getElementById('resetTutorialBtn').click());
  expect(await page.evaluate(() => save.hyperTutDone)).toBe(false);
  expect(fxErrors(errors)).toEqual([]);
});

test('touch: a slide steers (one long slide crosses two lanes), a tap fires, a vertical drag does neither; mouse clicks and keys still work', async ({ browser }) => {
  test.setTimeout(90000);
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = await boot(page, { save: { level: 60 } });
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  const slide = async (x0, y0, dx, dy, steps = 8) => {
    await touch('touchStart', x0, y0);
    for (let i = 1; i <= steps; i++) { await touch('touchMove', x0 + dx * i / steps, y0 + dy * i / steps); await page.waitForTimeout(16); }
    await touch('touchEnd', x0 + dx, y0 + dy);
    await page.waitForTimeout(60);
  };
  await startRun(page, true);
  await page.evaluate(() => Hyper.request());
  await page.waitForFunction(() => Hyper.cardOpen, null, { timeout: 10000 });
  const card = await page.evaluate(() => ({ touch: document.getElementById('hyperCard').classList.contains('touch'), rows: document.querySelector('#hyperCard .hc-rows').innerText }));
  expect(card.touch, 'a phone gets the touch controls').toBe(true);
  expect(card.rows).toMatch(/SLIDE/); expect(card.rows).toMatch(/TAP/);
  await page.tap('#hyperCardGo');
  await page.waitForFunction(() => state === 'playing', null, { timeout: 10000 });
  await page.waitForTimeout(400);
  const st = () => page.evaluate(() => ({ lane: Hyper.lane, ammo: Hyper.ammo }));
  expect((await st()).lane).toBe(1);
  await slide(206, 700, -150, 0);
  expect((await st()).lane, 'slide left: one lane (the edge stops it)').toBe(0);
  await slide(150, 700, 170, 4);
  expect((await st()).lane, 'one long slide right: two lanes').toBe(2);
  const before = await st();
  await slide(206, 760, 6, -170);
  expect(await st(), 'a vertical drag neither steers nor fires').toEqual(before);
  await touch('touchStart', 206, 640); await page.waitForTimeout(70); await touch('touchEnd', 206, 640); await page.waitForTimeout(60);
  expect((await st()).ammo, 'a tap fires').toBe(before.ammo - 1);
  await page.mouse.click(60, 640);
  expect((await st()).lane, 'a mouse click on the left half still steers').toBe(1);
  await page.keyboard.press('KeyD');
  expect((await st()).lane, 'keys still steer').toBe(2);
  const am = (await st()).ammo;
  await page.keyboard.press('Space');
  expect((await st()).ammo, 'Space still fires').toBe(Math.max(0, am - 1));
  expect(await page.evaluate(() => inputKind), 'the hints follow the last input').toBe('key');
  expect(fxErrors(errors)).toEqual([]);
  await ctx.close();
});

for (const low of [false, true]) {
  test(`30-second flight through the space-time tunnel toward a growing black hole (${low ? 'Low' : 'High'} graphics)`, async ({ page }) => {
    test.setTimeout(120000);
    const errors = await boot(page, { save: { level: 60, hyperTutDone: true, settings: { lowGraphics: low, spaceQuality: 'high' } } });
    await startRun(page, false);
    await page.evaluate(() => Hyper.request());
    await page.waitForFunction(() => Hyper.active, null, { timeout: 5000 });
    const t0 = await gameT(page);
    expect(await page.evaluate(() => Hyper.duration)).toBe(30);
    await page.waitForFunction((t0) => clockNow() - startTime > t0 + 4, t0, { timeout: 20000 });
    const r4 = await page.evaluate(() => Hyper._holeR());
    expect(await lit(page), 'the tunnel is drawn').toBeGreaterThan(0.08);
    await page.waitForFunction((t0) => clockNow() - startTime > t0 + 22, t0, { timeout: 60000 });
    const r22 = await page.evaluate(() => Hyper._holeR());
    expect(r4, 'the hole is there from the start').toBeGreaterThan(15);
    expect(r22 / r4, 'and it grows as we fall toward it').toBeGreaterThan(1.6);
    await page.waitForFunction(() => !Hyper.active, null, { timeout: 30000 });
    const [a0, a1] = await page.evaluate(() => Hyper._span());           // the game's own start and end (no polling lag)
    const len = a1 - a0;
    expect(len, 'about 30 seconds').toBeGreaterThan(29.5);
    expect(len).toBeLessThan(33);
    expect(fxErrors(errors), 'no drawing error').toEqual([]);
  });
}
