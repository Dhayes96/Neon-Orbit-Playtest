// Fixes from the Nov 13 bug sweep that affect the live game.
const { test, expect } = require('@playwright/test');
const { boot } = require('./harness');

test('Hit Rate counts only your own taps: rings a power clears for you never take it past 100%', async ({ page }) => {
  test.setTimeout(60000);
  const errors = await boot(page, { save: { level: 20 } });
  await page.evaluate(() => startGame(false));
  await page.waitForFunction(() => state === 'playing');
  // the bot hits rings with real (keyboard) taps for a few seconds, plus a few stray taps
  await page.evaluate(() => { window.__bot = setInterval(() => { const t = clockNow() - startTime; for (const n of notes) if (!n.hit && !n.missed && Math.abs(t - (n.hitTime + audioOffset())) < 0.03) { handleTap(null, true); break; } }, 8); });
  await page.waitForTimeout(6000);
  await page.evaluate(() => { clearInterval(window.__bot); for (let i = 0; i < 3; i++) { lastTapAt = 0; handleTap(null, true); } });
  // then a power clears 30 rings without a tap (as Hex Saw, Tri-Laser or the Supernova wave do)
  const before = await page.evaluate(() => ({ taps: runStats.taps, tapHits: runStats.tapHits }));
  await page.evaluate(() => { for (let i = 0; i < 30; i++) awardAbilityPerfect(tgt.x, tgt.y, '#fff', 'TEST'); });
  const r = await page.evaluate(() => { energy = 0; endGame(); return { taps: runStats.taps, tapHits: runStats.tapHits, hits: runStats.hits, shown: document.getElementById('slHitRate').textContent, acc: runAccuracy() }; });
  expect(before.tapHits).toBeGreaterThan(3);
  expect(r.taps).toBe(before.taps);
  expect(r.hits, 'power-cleared rings still count as clean hits (Accuracy)').toBe(before.tapHits + 30 + (r.hits - before.tapHits - 30));
  expect(r.shown).toBe(Math.round(before.tapHits / before.taps * 100) + '%');
  expect(parseInt(r.shown, 10)).toBeLessThanOrEqual(100);
  expect(errors).toEqual([]);
});

// Hyperdrive on a short landscape screen (a phone on its side, CrazyGames' 800x450 frame): the
// lanes were spaced by the screen's height (74 px apart under a ~350 px saucer), FIRE sat on the
// saucer, and the stage chip covered the tunnel's end.
for (const [W, H, short] of [[844, 390, true], [800, 450, true], [907, 510, true], [390, 844, false], [1280, 720, false]]) {
  test(`Hyperdrive layout at ${W}x${H}${short ? ' (short landscape)' : ''}`, async ({ page }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width: W, height: H });
    const errors = await boot(page, { save: { level: 20, hyperTutDone: true } });
    await page.evaluate(() => startGame(false));
    await page.waitForFunction(() => state === 'playing');
    await page.evaluate(() => { combo = 149; comboTier = COMBO_MILESTONES.findIndex((m) => m.hyper); window.__bot = setInterval(() => { const t = clockNow() - startTime; if (Hyper.active) return; for (const n of notes) if (!n.hit && !n.missed && Math.abs(t - (n.hitTime + audioOffset())) < 0.03) { handleTap(null, true); break; } }, 8); });
    await page.waitForFunction(() => Hyper.active, null, { timeout: 15000 });
    await page.waitForTimeout(2600);                              // past the fly-in: FIRE is up
    const g = await page.evaluate(() => { const G = Hyper._geo(), f = document.getElementById('hyperFire').getBoundingClientRect();
      return { short: G.short, lanePx: G.lanePx, yCraft: G.yCraft, R: targetR, fireTop: f.top, fireShown: f.height > 0,
        chip: getComputedStyle(document.getElementById('stageChip')).opacity, track: getComputedStyle(document.getElementById('trackName')).opacity }; });
    expect(g.short).toBe(short);
    expect(g.fireShown).toBe(true);
    if (short) {
      expect(g.lanePx, 'lanes spaced by the width').toBeGreaterThanOrEqual(Math.min(W * 0.3, H * 0.34) - 0.5);
      expect(g.yCraft + g.R * 0.45 * 1.3, 'the saucer clears FIRE').toBeLessThanOrEqual(g.fireTop + 2);
      expect(g.chip).toBe('0'); expect(g.track).toBe('0');
    } else {
      expect(g.lanePx, 'unchanged').toBeCloseTo(Math.min(W * 0.3, H * 0.19), 3);
    }
    expect(errors).toEqual([]);
  });
}
