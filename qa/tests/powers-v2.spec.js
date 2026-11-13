// Powers v2 (Dennel, Nov 12):
//  - HEX SAW is Hexatron's giant saw (2.15x the craft). Rings that reach it are caught on the
//    teeth (held at the rim, not drawn inside it) and cut ON their beat; anything still on the
//    teeth when it stops is cut too. Every cut is a PERFECT, no misses while it runs.
//  - BLACK PRISM (was Prism Guard) is Vanta Prism's crystal: it swallows every ring on its beat
//    and refracts it into a spectrum fan; still invincible; shatters and clears the field at the
//    end. Same id (prismGuard) so existing saves keep it.
//  - Both work in a boss fight (shots land on the boss) with no page errors.
const { test, expect } = require('@playwright/test');
const { boot, writeResult } = require('./harness');

const ALL = { cubex: true, hexatron: true, triarch: true, vantaPrism: true, eclipseSovereign: true, metronox: true, nullstar: true };

// Not before the beat, and on the first frame after it: within 0.1 s, or (on a slow CI frame) the
// previous update was still short of the beat. Never more than 0.5 s late.
const onBeat = (c) => c.t >= c.hit - 0.012 && c.t - c.hit < 0.5 && (c.t - c.hit < 0.1 || c.prev < c.hit - 0.01);

async function startWith(page, ability) {
  const errors = await boot(page, { save: { level: 50, equippedAbility: ability, bossUnlocks: ALL } });
  await page.evaluate(() => startGame(false));
  await page.waitForFunction(() => state === 'playing');
  await page.evaluate(() => {
    window.breakCombo = function () {}; setInterval(() => { energy = 100; }, 100);
    const log = window.__pw = { cuts: [], absorbs: [], prevT: -9, curT: -9 };
    // the game time of the previous ability update: "on its beat" means on the first update at or
    // after the beat, however late a slow CI frame makes that update
    const origUpd = window.updateAbility;
    window.updateAbility = function (dt, t) { log.prevT = log.curT; log.curT = t; return origUpd.apply(this, arguments); };
    for (const fn of ['sawCut', 'prismAbsorb']) {
      const orig = window[fn];
      window[fn] = function (note, t) { (fn === 'sawCut' ? log.cuts : log.absorbs).push({ t, hit: note.hitTime, prev: log.prevT, state: note.sawState, active: abActive }); return orig.apply(this, arguments); };
    }
  });
  await page.waitForTimeout(2500);   // let rings start flowing
  return errors;
}

test('Hex Saw v2: giant blade, rings caught at the rim, every cut on its beat', async ({ page }) => {
  const errors = await startWith(page, 'hexSaw');
  await page.evaluate(() => { abReady = true; activateAbility(); });
  // sample while it runs: blade size, and every caught ring is drawn at the rim, never inside it
  const samples = [];
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(60);
    samples.push(await page.evaluate(() => {
      const t = clockNow() - startTime, R = hexSawR(t);
      const caught = notes.filter((n) => !n.hit && !n.missed && n.sawState === 2);
      return { active: abActive, ratio: R / targetR, caught: caught.length,
        // what drawNotes would use for a caught ring vs the blade
        inside: caught.filter((n) => Math.max(noteRadius(n, t), R * 1.06) < R).length,
        sparks: sawSparks.length };
    }));
  }
  await page.evaluate(() => { if (abActive) endAbility('test'); });
  const log = await page.evaluate(() => window.__pw);
  writeResult('powers-v2-hexsaw', { samples, cuts: log.cuts.length });
  expect(errors).toEqual([]);
  expect(Math.max(...samples.map((s) => s.ratio)), 'blade is 2.15x the craft').toBeGreaterThan(2.1);
  expect(samples.some((s) => s.caught > 0), 'rings get caught on the teeth').toBe(true);
  expect(samples.every((s) => s.inside === 0), 'a caught ring is never drawn inside the blade').toBe(true);
  expect(samples.some((s) => s.sparks > 0), 'sparks fly').toBe(true);
  expect(log.cuts.length, 'it cut rings').toBeGreaterThan(3);
  // (the final sweep when the blade stops cuts whatever is still on the teeth, early by design)
  const offBeat = log.cuts.filter((c) => c.active && !onBeat(c));
  expect(offBeat.length, `every ring is cut on its beat: ${JSON.stringify(offBeat)}`).toBe(0);
  expect(await page.evaluate(() => notes.filter((n) => !n.hit && !n.missed && n.sawState === 2).length), 'nothing left on the teeth').toBe(0);
});

test('Black Prism: swallows every ring on its beat, refracts it, invincible, shatters at the end', async ({ page }) => {
  const errors = await startWith(page, 'prismGuard');
  const meta = await page.evaluate(() => ({ name: ABILITIES.prismGuard.name, short: ABILITIES.prismGuard.short }));
  expect(meta).toEqual({ name: 'Black Prism', short: 'PRISM' });
  const missesBefore = await page.evaluate(() => runStats.misses);
  await page.evaluate(() => { abReady = true; activateAbility(); });
  let fans = 0;
  for (let i = 0; i < 20; i++) { await page.waitForTimeout(250); fans = Math.max(fans, await page.evaluate(() => prismFans.length)); }
  const mid = await page.evaluate(() => ({ misses: runStats.misses, absorbs: window.__pw.absorbs }));
  await page.evaluate(() => { if (abActive) endAbility('expired'); });
  const after = await page.evaluate(() => ({ shards: prismShards.length, live: notes.filter((n) => !n.hit && !n.missed).length }));
  writeResult('powers-v2-prism', { mid, fans, after });
  expect(errors).toEqual([]);
  expect(mid.absorbs.length, 'it swallowed rings').toBeGreaterThan(3);
  expect(mid.absorbs.filter((a) => !onBeat(a)), 'each one on its beat').toEqual([]);
  expect(mid.misses, 'no misses while it runs').toBe(missesBefore);
  expect(fans, 'spectrum fans fire').toBeGreaterThan(0);
  expect(after.shards, 'the crystal shatters at the end').toBeGreaterThan(0);
  expect(after.live, 'and clears the field').toBe(0);
});

for (const [ability, stage] of [['hexSaw', 20], ['prismGuard', 40]]) {
  test(`${ability} in a boss fight (stage ${stage}): runs clean and hits the boss`, async ({ page }) => {
    const errors = await startWith(page, ability);
    await page.evaluate((st) => { hitsTotal = stageHitsNeeded(st, diff); stageUp(st); }, stage);
    await page.waitForFunction(() => state === 'bossBattle', null, { timeout: 30000 });
    const hp0 = await page.evaluate(() => bossHealth);
    await page.evaluate(() => { abReady = true; activateAbility(); });
    await page.waitForTimeout(5000);
    const hp1 = await page.evaluate(() => bossHealth);
    expect(errors).toEqual([]);
    expect(hp1, 'the boss took damage').toBeLessThan(hp0);
  });
}
