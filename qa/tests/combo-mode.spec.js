// Score mode in the combo panel (Dennel, Nov 12):
//  - The big floating Combo Fever / Supernova / Singularity banner is gone from the playfield.
//  - The top-centre combo panel is the mode indicator: its label reads the mode ("FEVER ×1.5",
//    "SUPERNOVA ×2", "SINGULARITY ×3") above the combo count, and it keeps a subtle glow in the
//    mode's colour.
//  - Going UP a mode plays a ~1 s celebration on the panel (pulse, ring, energy sweep) that stays
//    inside the HUD: it never reaches the saucer, the boss, the boss name/bar or the stage chip.
//  - It plays only when the mode goes up: not on combo increments, not when Singularity drops to
//    Supernova, not when Fever ends. Winning Singularity back does celebrate.
//  - Presentation only: thresholds, multipliers and the milestone flow are unchanged.
// Checked on phone sizes (portrait + landscape, touch), a CrazyGames size and desktop, in normal
// play and in a boss fight.
const { test, expect } = require('@playwright/test');
const { boot, writeResult } = require('./harness');
const fs = require('fs');
const path = require('path');

const SHOTS = path.join(__dirname, '..', 'results', 'combo-mode');
const SAVE = { level: 60, equippedAbility: 'hexSaw', bossUnlocks: { cubex: true, hexatron: true, triarch: true, vantaPrism: true, eclipseSovereign: true } };
const SIZES = [['iphone-15-p', 393, 852, 3, true], ['iphone-15-l', 852, 393, 3, true], ['small-320-p', 320, 568, 2, true],
  ['cg-800', 800, 450, 1, true], ['desktop', 1280, 720, 1, false]];
const LABELS = { 1: 'Fever ×1.5', 2: 'Supernova ×2', 3: 'Singularity ×3' };

// In-page: what the celebration (at its widest) must stay off.
function clearOf(z) {
  const box = (el) => { if (!el || getComputedStyle(el).display === 'none') return null; const r = el.getBoundingClientRect(); return r.width ? { l: r.left, t: r.top, r: r.right, b: r.bottom } : null; };
  const overlap = (a, b) => a && b && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
  const hitCircle = (b, x, y, rad) => { const nx = Math.min(Math.max(x, b.l), b.r), ny = Math.min(Math.max(y, b.t), b.b); return (nx - x) ** 2 + (ny - y) ** 2 < rad * rad; };
  const bad = [];
  if (z.l < 0 || z.r > innerWidth || z.t < 0) bad.push('off screen');
  for (const a of anchors) if (hitCircle(z, a.x, a.y, targetR * 1.3)) bad.push('reaches the saucer at ' + a.id);
  if (hitCircle(z, tgt.x, tgt.y, targetR * 1.3)) bad.push('reaches the saucer');
  if (stageChip.classList.contains('show') && !stageChip.classList.contains('boss-hidden') && overlap(z, box(stageChip))) bad.push('overlaps the stage chip');
  if (bossHud.classList.contains('show')) {
    if (overlap(z, box(bossNameEl))) bad.push('overlaps the boss name');
    if (overlap(z, box(document.getElementById('bossBar')))) bad.push('overlaps the boss bar');
    if (bossActive && hitCircle(z, bossX(), bossY(), bossR())) bad.push('reaches the boss');
  }
  return bad;
}

for (const [name, w, h, dpr, touch] of SIZES) {
  for (const boss of [false, true]) {
    test(`combo panel shows the mode, celebrates inside the HUD: ${name} ${w}x${h}${boss ? ' boss fight' : ''}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, isMobile: touch, hasTouch: touch });
      const page = await ctx.newPage();
      const errors = await boot(page, { save: SAVE });
      await page.evaluate(`window.clearOf = ${clearOf.toString()}`);
      await page.evaluate(() => startGame(false));
      await page.waitForFunction(() => state === 'playing');
      await page.evaluate(() => { window.breakCombo = function () {}; setInterval(() => { energy = 100; }, 100); perfectRun = 300; });
      if (boss) {
        // (this test stands still to look at the HUD; a boss hit would take a score mode, which boss-dodge.spec.js covers)
        await page.evaluate(() => { window.dodgeHit = function () {}; hitsTotal = stageHitsNeeded(20, diff); stageUp(20); });
        await page.waitForFunction(() => state === 'bossBattle', null, { timeout: 20000 });
      }
      await page.waitForTimeout(600);
      expect(await page.evaluate(() => document.getElementById('feverBanner')), 'no floating Fever banner').toBeNull();
      const res = { levels: {} };
      for (const lv of [1, 2, 3]) {
        await page.evaluate((lv) => setFeverLevel(lv), lv);
        const start = await page.evaluate(() => ({ cls: comboPanel.className, label: comboLabel.textContent }));
        const bad = new Set(), scales = [];
        const t0 = Date.now();
        while (Date.now() - t0 < 1200) {
          const s = await page.evaluate(() => {
            const r = comboPanel.getBoundingClientRect(), k = r.width / comboPanel.offsetWidth;
            const cx = (r.left + r.right) / 2, rw = comboPanel.offsetWidth, rh = comboPanel.offsetHeight;
            // the ring at its widest (2 px out on the sides and top, scale(1.12, 1.06) from the bottom
            // edge), on top of the panel's pulse as drawn right now (also from the bottom edge)
            const hw = (rw / 2 + 2) * 1.12 * k, hh = (rh + 2) * 1.06 * k;
            const z = { l: cx - hw, r: cx + hw, t: r.bottom - hh, b: r.bottom };
            return { k, bad: clearOf(z), up: comboPanel.classList.contains('mode-up') };
          });
          scales.push(s.k); s.bad.forEach((b) => bad.add(b));
          await page.waitForTimeout(40);
        }
        await page.waitForTimeout(150);
        const settled = await page.evaluate(() => {
          const cs = getComputedStyle(comboPanel), lab = getComputedStyle(comboLabel);
          const rg = document.createRange(); rg.selectNodeContents(comboLabel);
          const inner = comboPanel.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
          return { cls: comboPanel.className, label: comboLabel.textContent, up: comboPanel.classList.contains('mode-up'),
            glow: cs.boxShadow, labelOpacity: +lab.opacity, labelFits: rg.getBoundingClientRect().width <= inner + 1,
            combo: getComputedStyle(comboEl).display !== 'none' && comboEl.getBoundingClientRect().height > 8 };
        });
        res.levels[lv] = { start, scales: [Math.min(...scales), Math.max(...scales)], bad: [...bad].filter(Boolean), settled };
        if (lv === 3) fs.mkdirSync(SHOTS, { recursive: true }), await page.screenshot({ path: path.join(SHOTS, `${name}${boss ? '-boss' : ''}.png`) });
      }
      writeResult(`combo-mode-${name}${boss ? '-boss' : ''}`, res);
      await ctx.close();
      expect(errors).toEqual([]);
      for (const lv of [1, 2, 3]) {
        const L = res.levels[lv];
        expect(L.start.cls, `L${lv}: the panel takes the mode and celebrates`).toBe(`panel center mode-${lv} mode-up`);
        expect(L.start.label).toBe(LABELS[lv]);
        expect(L.scales[1], `L${lv}: it pulses`).toBeGreaterThan(1.03);
        expect(L.scales[1], `L${lv}: a small pulse`).toBeLessThan(1.12);
        expect(L.bad, `L${lv}: the celebration stays inside the HUD`).toEqual([]);
        expect(L.settled.up, `L${lv}: done after about a second`).toBe(false);
        expect(L.settled.cls).toBe(`panel center mode-${lv}`);
        expect(L.settled.glow, `L${lv}: a mode-coloured glow`).not.toBe('none');
        expect(L.settled.labelOpacity, `L${lv}: label fully readable`).toBe(1);
        expect(L.settled.labelFits, `L${lv}: label fits the panel`).toBe(true);
        expect(L.settled.combo, `L${lv}: combo count still shown`).toBe(true);
      }
    });
  }
}

test('the celebration plays only when the mode goes up', async ({ page }) => {
  const errors = await boot(page, { save: SAVE });
  await page.evaluate(() => startGame(false));
  await page.waitForFunction(() => state === 'playing');
  await page.evaluate(() => {
    window.breakCombo = function () {}; setInterval(() => { energy = 100; }, 100);
    window.__ups = 0;
    new MutationObserver(() => { const on = comboPanel.classList.contains('mode-up'); if (on && !window.__was) window.__ups++; window.__was = on; })
      .observe(comboPanel, { attributes: true, attributeFilter: ['class'] });
    // a perfect player, so the combo climbs on its own
    window.__auto = true;
    setInterval(() => {
      if (!window.__auto || state !== 'playing') return;
      const t = clockNow() - startTime;
      for (const n of notes) if (!n.hit && !n.missed && Math.abs(t - (n.hitTime + audioOffset())) < 0.03) { handleTap(null, true); break; }
    }, 8);
  });
  await page.evaluate(() => setFeverLevel(1));
  await page.waitForTimeout(1300);
  const c0 = await page.evaluate(() => ({ ups: __ups, combo }));
  await page.waitForTimeout(6000);                              // combo increments only
  const c1 = await page.evaluate(() => ({ ups: __ups, combo, cls: comboPanel.className }));
  await page.evaluate(() => { window.__auto = false; perfectRun = 300; setFeverLevel(3); });
  await page.waitForTimeout(1300);
  // (the observer reports a beat later, so each read waits a moment after the change)
  await page.evaluate(() => dropSingularity());
  await page.waitForTimeout(100);
  const c2 = await page.evaluate(() => ({ ups: __ups, cls: comboPanel.className, label: comboLabel.textContent }));
  await page.evaluate(() => { perfectRun = SING_REGAIN - 1; notePerfect(); });
  await page.waitForTimeout(100);
  const c3 = await page.evaluate(() => ({ ups: __ups, level: feverLevel, label: comboLabel.textContent }));
  await page.waitForTimeout(1300);
  await page.evaluate(() => setFever(false));
  await page.waitForTimeout(100);
  const c4 = await page.evaluate(() => ({ ups: __ups, cls: comboPanel.className, label: comboLabel.textContent }));
  writeResult('combo-mode-only-on-change', { c0, c1, c2, c3, c4 });
  expect(errors).toEqual([]);
  expect(c0.ups, 'Fever celebrates once').toBe(1);
  expect(c1.combo, 'the combo kept climbing').toBeGreaterThan(c0.combo + 3);
  expect(c1.ups, 'combo increments do not celebrate').toBe(1);
  expect(c1.cls).toBe('panel center mode-1');
  expect(c2.ups, 'Singularity celebrates; losing it does not').toBe(2);
  expect(c2.cls).toBe('panel center mode-2');
  expect(c2.label).toBe('Supernova ×2');
  expect(c3, 'winning Singularity back celebrates').toEqual({ ups: 3, level: 3, label: 'Singularity ×3' });
  expect(c4, 'Fever ending is quiet and resets the panel').toEqual({ ups: 3, cls: 'panel center', label: 'Combo' });
});

test('presentation only: thresholds, multipliers and the milestone flow are unchanged', async ({ page }) => {
  const errors = await boot(page, { save: SAVE });
  await page.evaluate(() => startGame(false));
  await page.waitForFunction(() => state === 'playing');
  const k = await page.evaluate(() => ({ mults: FEVER_MULTS, fm: FEVER_MULT,
    ms: COMBO_MILESTONES.map((m) => [m.combo, m.fever || 0, m.bonus]) }));
  expect(k.mults).toEqual([1, k.fm, 2, 3]);
  expect(k.fm).toBe(1.5);
  expect(k.ms).toEqual([[25, 1, 250], [50, 0, 750], [100, 2, 2500], [150, 0, 4000], [175, 0, 5000], [250, 3, 10000]]);
  const steps = await page.evaluate(() => {
    window.breakCombo = function () {}; Hyper.request = function () {};
    const out = [];
    for (const c of [24, 25, 99, 100, 249, 250]) { combo = c; perfectRun = c; checkComboMilestones(); out.push([c, fever, feverLevel, comboLabel.textContent]); }
    return out;
  });
  expect(steps).toEqual([[24, false, 0, 'Combo'], [25, true, 1, 'Fever ×1.5'], [99, true, 1, 'Fever ×1.5'], [100, true, 2, 'Supernova ×2'],
    [249, true, 2, 'Supernova ×2'], [250, true, 3, 'Singularity ×3']]);
  expect(errors).toEqual([]);
});

test('reduced motion: no pulse or sweep, the mode glow and label stay', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errors = await boot(page, { save: SAVE });
  await page.evaluate(() => startGame(false));
  await page.waitForFunction(() => state === 'playing');
  const r = await page.evaluate(() => { setFeverLevel(2); const cs = getComputedStyle(comboPanel);
    return { anim: cs.animationName, sweep: getComputedStyle(comboPanel, '::after').animationName, cls: comboPanel.className, glow: cs.boxShadow }; });
  await ctx.close();
  expect(errors).toEqual([]);
  expect(r.anim).toBe('none');
  expect(r.sweep).toBe('none');
  expect(r.cls).toContain('mode-2');
  expect(r.glow).not.toBe('none');
});
