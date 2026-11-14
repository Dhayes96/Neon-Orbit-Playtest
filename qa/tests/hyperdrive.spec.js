// Hyperdrive (combo 150): a 30-second chase-camera flight between rocks and rings (the first-flight
// controls card is covered by hyperdrive-v3.spec.js; these flights are seeded as already seen).
// Nov 13 regression: with Project Zero's craft switch, Hyperdrive's own local drawCraft called
// itself until the stack overflowed. Every frame of the flight threw, left thousands of canvas
// save()s unrestored, and the play field stayed black for the rest of the run.
const { test, expect } = require('@playwright/test');
const { boot } = require('./harness');

const fxErrors = (errors) => errors.filter((e) => /\[fx\]|Maximum call stack|RangeError/.test(e));
// how much of the play field is lit (0..1), sampled on a coarse grid of the canvas
const lit = (page) => page.evaluate(() => {
  const c = document.getElementById('game') || document.querySelector('canvas'), g = c.getContext('2d');
  const d = g.getImageData(0, 0, c.width, c.height).data; let on = 0, n = 0;
  for (let y = Math.floor(c.height * 0.15); y < c.height * 0.85; y += 12) for (let x = 0; x < c.width; x += 12) { const i = (y * c.width + x) * 4; n++; if (d[i] + d[i + 1] + d[i + 2] > 60) on++; }
  return on / n;
});
async function fly(page, save) {
  const errors = await boot(page, { save: Object.assign({ level: 60, hyperTutDone: true }, save || {}) });
  await page.evaluate(() => startGame(false));
  await page.waitForFunction(() => state === 'playing');
  await page.evaluate(() => {
    window.__crafts = 0; const cd = CraftFX.draw; CraftFX.draw = function () { if (Hyper.active) window.__crafts++; return cd.apply(this, arguments); };
    window.__orbs = 0; const zo = drawZeroOrb; window.drawZeroOrb = function () { if (Hyper.active) window.__orbs++; return zo.apply(this, arguments); };
    setInterval(() => {
      if (state !== 'playing') return;
      const t = clockNow() - startTime;
      if (!Hyper.active) { for (const n of notes) if (!n.hit && !n.missed && Math.abs(t - (n.hitTime + audioOffset())) < 0.03) { handleTap(null, true); break; } }
    }, 8);
    combo = 149; comboTier = 3; perfectRun = 50;               // the next hit reaches combo 150
  });
  await page.waitForFunction(() => Hyper.active, null, { timeout: 15000 });
  return errors;
}

test('Hyperdrive: the flight draws (tunnel, craft, HUD), steers, fires, ends, and the play field comes back', async ({ page }) => {
  test.setTimeout(150000);
  const errors = await fly(page);
  await page.waitForTimeout(3500);                              // past the 1.8 s fly-in
  expect(await lit(page), 'the tunnel is drawn').toBeGreaterThan(0.08);
  expect(await page.evaluate(() => window.__crafts), 'the craft is drawn every frame').toBeGreaterThan(30);
  const l0 = await page.evaluate(() => Hyper.lane);
  await page.keyboard.press('ArrowLeft');
  expect(await page.evaluate(() => Hyper.lane)).toBe(Math.max(0, l0 - 1));
  await page.keyboard.press('KeyD'); await page.keyboard.press('KeyD');
  expect(await page.evaluate(() => Hyper.lane)).toBe(Math.min(2, Math.max(0, l0 - 1) + 2));
  const a0 = await page.evaluate(() => Hyper.ammo);
  await page.keyboard.press('Space');
  expect(await page.evaluate(() => Hyper.ammo)).toBe(a0 - 1);
  expect(await page.evaluate(() => document.querySelector('#hyperBtns.show') !== null), 'FIRE button').toBe(true);
  expect(fxErrors(errors), 'no drawing error during the flight').toEqual([]);
  await page.waitForFunction(() => !Hyper.active, null, { timeout: 45000 });
  await page.waitForTimeout(3000);
  const after = await page.evaluate(() => ({ state, rings: notes.filter((n) => !n.hit && !n.missed).length, btns: document.querySelector('#hyperBtns.show') !== null, body: document.body.classList.contains('hyper-on'),
    tf: (() => { const m = ctx.getTransform(); return [m.a, m.d, m.e, m.f]; })(), dpr: DPR }));
  expect(after).toMatchObject({ state: 'playing', btns: false, body: false });
  expect(after.rings, 'rings are back').toBeGreaterThan(0);
  expect(after.tf, 'the canvas is back to its base transform').toEqual([after.dpr, after.dpr, 0, 0]);
  expect(await lit(page), 'the play field is drawn after the flight').toBeGreaterThan(0.002);
  expect(fxErrors(errors)).toEqual([]);
});

test('Hyperdrive with Zero Form equipped: the orb flies the tunnel', async ({ page }) => {
  test.setTimeout(60000);
  const errors = await fly(page, { level: 100, bestStage: 100, craft: 'zero', zero: { opened: true } });
  await page.waitForTimeout(3000);
  expect(await page.evaluate(() => craftIsZero())).toBe(true);
  expect(await page.evaluate(() => window.__orbs), 'the orb is drawn').toBeGreaterThan(30);
  expect(await lit(page)).toBeGreaterThan(0.08);
  expect(fxErrors(errors)).toEqual([]);
});

test('an effect that throws half-way does not blank the play field for the rest of the run', async ({ page }) => {
  const errors = await boot(page, { save: { level: 20 } });
  await page.evaluate(() => startGame(false));
  await page.waitForFunction(() => state === 'playing');
  await page.waitForTimeout(800);
  // a broken effect, like the recursive drawCraft: save, transform, save, transform... then a throw
  await page.evaluate(() => { const orig = drawNovaFX; let n = 0; window.drawNovaFX = function () { if (n++ < 2) { for (let i = 0; i < 50; i++) { ctx.save(); ctx.translate(40, 30); ctx.scale(0.8, 0.8); ctx.globalAlpha *= 0.8; } throw new Error('test: a broken effect'); } return orig.apply(this, arguments); }; });
  await page.waitForTimeout(600);
  const r = await page.evaluate(() => ({ tf: (() => { const m = ctx.getTransform(); return [m.a, m.d]; })(), alpha: ctx.globalAlpha, dpr: DPR }));
  expect(r).toEqual({ tf: [r.dpr, r.dpr], alpha: 1, dpr: r.dpr });
  expect(await lit(page)).toBeGreaterThan(0.002);
  expect(errors.filter((e) => /a broken effect/.test(e)).length, 'reported, not hidden').toBeGreaterThan(0);
});
