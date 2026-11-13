// HUD docks + pause Main Menu (Dennel, Nov 12):
//  1. The Combo Fever banner and the power chip must never sit where the saucer flies, on any
//     screen: phones (portrait + landscape, touch), tablets, desktop and the 10 CrazyGames sizes.
//     The chip sits in the upper-left: wide screens dock it under Score and Fever under Best beside
//     Pause; narrow portrait phones put the chip at the left of the first row under the HUD and
//     Fever in the second, both below the boss bar in a boss fight.
//  2. Neither may cover another HUD element (panels, stage chip, boss name/bar, Pause + its halo,
//     energy bar) or leave the screen, with the longest texts (Supernova, "HOLD TO EXIT", timer).
//  3. The chip hides during Hyperdrive (its own FIRE / CORE buttons sit at the bottom).
//  4. Pause has a Main Menu button: first tap arms it ("Tap again to quit", 3 s), the second ends
//     the run (scored like any ending), lands on the title screen with its music, and a new run
//     starts with gameplay music. One touchend + its click count as one press.
// Saucer footprint = 1.3 x targetR around each anchor (dome, disc and glow).
const { test, expect } = require('@playwright/test');
const { boot, writeResult } = require('./harness');
const fs = require('fs');
const path = require('path');

const SHOTS = path.join(__dirname, '..', 'results', 'hud-docks');
const SIZES = [
  // name, w, h, dpr, touch
  ['iphone-15-p', 393, 852, 3, true], ['iphone-15-l', 852, 393, 3, true],
  ['iphone-se-p', 375, 667, 2, true], ['iphone-se-l', 667, 375, 2, true],
  ['small-320-p', 320, 568, 2, true], ['pixel-7-p', 412, 915, 2.6, true], ['pixel-7-l', 915, 412, 2.6, true],
  ['ipad-p', 820, 1180, 2, true], ['ipad-l', 1180, 820, 2, true],
  ['laptop', 1366, 768, 1, false], ['desktop', 1920, 1080, 1, false], ['narrow-window', 620, 900, 1, false],
  // the 10 CrazyGames iframe sizes (DPR 1); 800x450 and 1080x607 are their mobile / tablet sizes
  ['cg-907', 907, 510, 1, false], ['cg-1216', 1216, 684, 1, false], ['cg-1077', 1077, 606, 1, false],
  ['cg-821', 821, 462, 1, false], ['cg-1366', 1366, 768, 1, false], ['cg-1920', 1920, 1080, 1, false],
  ['cg-1536', 1536, 864, 1, false], ['cg-1280', 1280, 720, 1, false], ['cg-800', 800, 450, 1, true], ['cg-1080', 1080, 607, 1, true],
];
const SAVE = { level: 60, equippedAbility: 'eventHorizon', overclock: true,
  bossUnlocks: { cubex: true, hexatron: true, triarch: true, vantaPrism: true, eclipseSovereign: true } };

// In-page: dock rects vs the saucer and the rest of the HUD, for the state the page is in now.
function probe(label) {
  const box = (el) => { if (!el) return null; const cs = getComputedStyle(el); if (cs.display === 'none') return null;
    const r = el.getBoundingClientRect(); return r.width ? { l: r.left, t: r.top, r: r.right, b: r.bottom } : null; };
  const hitCircle = (b, x, y, rad) => { const nx = Math.min(Math.max(x, b.l), b.r), ny = Math.min(Math.max(y, b.t), b.b); return (nx - x) ** 2 + (ny - y) ** 2 < rad * rad; };
  const overlap = (a, b, pad = 0) => a && b && a.l < b.r + pad && b.l < a.r + pad && a.t < b.b + pad && b.t < a.b + pad;
  const docks = { fever: feverBanner.classList.contains('on') ? box(feverBanner) : null, chip: box(abilityStatus) };
  const panels = [...document.querySelectorAll('.hud .panel')].map(box);
  const others = { score: panels[0], combo: panels[1], best: panels[2], energy: box(document.querySelector('.energy-wrap')),
    pause: box(document.getElementById('pauseBtn')) };
  if (stageChip.classList.contains('show') && !stageChip.classList.contains('boss-hidden')) others.stage = box(stageChip);
  if (bossHud.classList.contains('show')) { others.bossName = box(bossNameEl); others.bossBar = box(document.getElementById('bossBar')); }
  const bad = [];
  for (const [k, d] of Object.entries(docks)) {
    if (!d) continue;
    if (d.l < -0.5 || d.t < -0.5 || d.r > innerWidth + 0.5 || d.b > innerHeight + 0.5) bad.push(`${label}: ${k} off screen`);
    for (const a of anchors) if (hitCircle(d, a.x, a.y, targetR * 1.3)) bad.push(`${label}: ${k} over the saucer at ${a.id}`);
    for (const [ok, ob] of Object.entries(others)) if (overlap(d, ob, ok === 'pause' ? 10 : 0)) bad.push(`${label}: ${k} overlaps ${ok}`);
  }
  if (overlap(docks.fever, docks.chip)) bad.push(`${label}: fever overlaps chip`);
  // Dennel (Nov 12): the power chip lives in the upper-left corner
  if (docks.chip && !((docks.chip.l + docks.chip.r) / 2 < innerWidth * 0.42 && docks.chip.b < Math.max(250, innerHeight * 0.3)))
    bad.push(`${label}: chip not in the upper-left`);
  // text wider than the box's content area = cut off (scrollWidth can't be used: the banner's shine sweeps outside it)
  const cut = (el, textEl) => { const rg = document.createRange(); rg.selectNodeContents(textEl); const cs = getComputedStyle(el);
    return rg.getBoundingClientRect().width > el.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth) + 1; };
  if (docks.chip && cut(abilityStatus, abilityStatusText)) bad.push(`${label}: chip text cut off`);
  const timer = abilityStatus.querySelector('.on');   // compact mode may drop the count, never the timer / HOLD
  if (docks.chip && timer && (getComputedStyle(timer).display === 'none' || !timer.getClientRects().length)) bad.push(`${label}: chip lost its timer`);
  if (docks.fever && cut(feverBanner, feverBanner)) bad.push(`${label}: Fever text cut off`);
  return { bad, wide: document.body.classList.contains('hud-wide'), docks, R: targetR, anchors: anchors.map((a) => a.id).join(' ') };
}

// Nobody taps in these layout checks: keep the combo (and so Fever) and the energy up.
const KEEP_RUN = () => { window.breakCombo = function () {}; setInterval(() => { energy = 100; }, 100); };

async function shot(page, name) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png') }); }

for (const [name, w, h, dpr, touch] of SIZES) {
  test(`HUD docks ${name} ${w}x${h}: Fever and the power chip stay off the saucer and the HUD`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, isMobile: touch, hasTouch: touch });
    const page = await ctx.newPage();
    const errors = await boot(page, { save: SAVE });
    await page.evaluate(() => startGame(false));
    await page.waitForFunction(() => state === 'playing', null, { timeout: 8000 });
    await page.evaluate(KEEP_RUN);
    await page.waitForTimeout(500);
    const res = { size: `${w}x${h}`, states: {} };
    const settle = () => page.waitForTimeout(450);   // let the Fever banner's 180 ms transition finish

    // A: Combo Fever + chip "HOLD"
    await page.evaluate(() => { setFeverLevel(1); abReady = true; updateAbilityHud(); });
    await settle(); res.states.fever = await page.evaluate(probe, 'fever'); await shot(page, `${name}-fever`);
    // B: Supernova + the widest real chip text (a running Tri-Laser, Overclocked: time + slices left)
    await page.evaluate(() => { setFeverLevel(2); abilityStatus.classList.add('on-air');
      abilityStatusText.innerHTML = '⚡' + ABILITIES.triLaser.short + ' <span class="on">12s</span><span class="uses">· 5 SLICES</span>';
      fitAbilityChip(); });   // as tickAbilityHud() does after every text change
    await settle(); res.states.supernova = await page.evaluate(probe, 'supernova');
    // C: the same in a boss fight with the longest boss name
    await page.evaluate(() => { stageChip.classList.add('boss-hidden'); bossNameEl.textContent = 'ECLIPSE SOVEREIGN'; bossHud.classList.add('show'); });
    await settle(); res.states.boss = await page.evaluate(probe, 'boss'); await shot(page, `${name}-boss`);
    // D: Hyperdrive hides the chip
    expect(await page.evaluate(() => fever && feverLevel === 2), 'Fever stayed on through the checks').toBe(true);
    res.hyperChipHidden = await page.evaluate(() => { bossHud.classList.remove('show'); stageChip.classList.remove('boss-hidden');
      Hyper.start(clockNow() - startTime); const hidden = getComputedStyle(abilityStatus).display === 'none'; Hyper.cancel();
      return hidden && getComputedStyle(abilityStatus).display !== 'none'; });

    res.errors = errors;
    writeResult(`hud-docks-${name}`, res);
    await ctx.close();
    const bad = Object.values(res.states).flatMap((s) => s.bad);
    expect(errors).toEqual([]);
    expect(bad, `${name}: ${JSON.stringify(res.states.fever.docks)}`).toEqual([]);
    expect(res.hyperChipHidden, 'chip hidden in Hyperdrive, back after').toBe(true);
  });
}

test('HUD docks follow a rotation: iPhone portrait -> landscape -> portrait', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = await boot(page, { save: SAVE });
  await page.evaluate(() => startGame(false));
  await page.waitForFunction(() => state === 'playing');
  await page.evaluate(KEEP_RUN);
  await page.evaluate(() => { setFeverLevel(1); abReady = true; updateAbilityHud(); });
  const seen = [];
  for (const [w, h] of [[390, 844], [844, 390], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(1300);   // rotation settle passes
    seen.push(await page.evaluate(probe, `${w}x${h}`));
  }
  await ctx.close();
  expect(errors).toEqual([]);
  expect(seen.map((s) => s.wide)).toEqual([false, true, false]);
  expect(seen.flatMap((s) => s.bad)).toEqual([]);
});

// ---------------- Pause -> Main Menu ----------------
async function startAndPause(page) {
  await page.click('#startBtn');
  await page.waitForFunction(() => state === 'playing', null, { timeout: 8000 });
  await page.waitForTimeout(1500);
  await page.click('#pauseBtn');
  await page.waitForFunction(() => state === 'paused');
}

test('Pause: Main Menu asks for a second tap, then ends the run and returns to the title screen', async ({ page }) => {
  const errors = await boot(page, { save: { level: 3, xp: 0 } });
  await startAndPause(page);
  const btn = page.locator('#pauseMenuBtn');
  await expect(btn).toBeVisible();
  await expect(btn).toHaveText('Main Menu');

  // first press arms it; it disarms by itself after 3 s and the run is untouched
  await btn.click();
  await expect(btn).toHaveText('Tap again to quit');
  await expect(page.locator('#pauseMsg')).toContainText('ends the run');
  await page.waitForTimeout(3300);
  await expect(btn).toHaveText('Main Menu');
  expect(await page.evaluate(() => state)).toBe('paused');

  // arming then Resume: disarmed, normal 3-2-1 resume
  await btn.click();
  await page.click('#pauseResumeBtn');
  await expect(btn).toHaveText('Main Menu');
  await page.waitForFunction(() => state === 'playing', null, { timeout: 8000 });

  // pause again, two presses: back on the title screen, run scored, title music on
  await page.click('#pauseBtn');
  await page.waitForFunction(() => state === 'paused');
  const xpBefore = await page.evaluate(() => save.level * 1e6 + save.xp);
  await btn.click();
  await page.waitForTimeout(500);
  await btn.click();
  await page.waitForFunction(() => state === 'menu', null, { timeout: 3000 });
  const after = await page.evaluate(() => ({
    menu: !document.getElementById('menuScreen').classList.contains('hidden'),
    over: !document.getElementById('overScreen').classList.contains('hidden'),
    pauseShown: document.getElementById('pauseOverlay').classList.contains('show'),
    pauseBtn: getComputedStyle(document.getElementById('pauseBtn')).display,
    chip: getComputedStyle(abilityStatus).display, fever, hyper: Hyper.active,
    menuMusic: menuMusic.on, gameMusic: music.on, ctx: audioCtx && audioCtx.state,
    xp: save.level * 1e6 + save.xp, notes: notes.length,
  }));
  expect(after.menu).toBe(true);
  expect(after.over).toBe(false);
  expect(after.pauseShown).toBe(false);
  expect(after.pauseBtn).toBe('none');
  expect(after.chip).toBe('none');
  expect(after.fever).toBe(false);
  expect(after.menuMusic).toBe(true);
  expect(after.gameMusic).toBe(false);
  expect(after.ctx).toBe('running');
  expect(after.xp, 'the quit run still earns XP').toBeGreaterThan(xpBefore);
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => state)).toBe('menu');   // no results screen pops up later

  // a fresh run afterwards has gameplay music (the pause had muted the music bus)
  await page.click('#startBtn');
  await page.waitForFunction(() => state === 'playing', null, { timeout: 8000 });
  await page.waitForTimeout(1500);
  const run2 = await page.evaluate(() => ({ on: music.on, gain: musicGain.gain.value, menuMusic: menuMusic.on }));
  expect(run2.on).toBe(true);
  expect(run2.gain).toBeGreaterThan(0.01);
  expect(run2.menuMusic).toBe(false);
  writeResult('pause-main-menu', { after, run2 });
  expect(errors).toEqual([]);
});

test('Pause: one touchend + its synthetic click arm Main Menu once (no instant quit)', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  const page = await ctx.newPage();
  const errors = await boot(page, {});
  await startAndPause(page);
  await page.evaluate(() => {
    const b = document.getElementById('pauseMenuBtn');
    b.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true }));
    b.click();
  });
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => state)).toBe('paused');
  await expect(page.locator('#pauseMenuBtn')).toHaveText('Tap again to quit');
  await page.waitForTimeout(400);
  await page.locator('#pauseMenuBtn').tap();
  await page.waitForFunction(() => state === 'menu', null, { timeout: 3000 });
  await ctx.close();
  expect(errors).toEqual([]);
});

test('Pause: Main Menu mid boss fight, with Supernova and a power running, clears all of it', async ({ page }) => {
  const errors = await boot(page, { save: SAVE });
  await page.evaluate(() => startGame(false));
  await page.waitForFunction(() => state === 'playing');
  await page.evaluate(() => { hitsTotal = stageHitsNeeded(10, diff); stageUp(10); });
  await page.waitForFunction(() => state === 'bossBattle', null, { timeout: 20000 });
  await page.evaluate(() => { setFeverLevel(2); abReady = true; activateAbility(); });
  await page.waitForTimeout(400);
  await page.evaluate(() => pauseGame('button'));
  await page.click('#pauseMenuBtn');
  await page.waitForTimeout(500);
  await page.click('#pauseMenuBtn');
  await page.waitForFunction(() => state === 'menu', null, { timeout: 3000 });
  const s = await page.evaluate(() => ({ boss: bossActive, bossHud: bossHud.classList.contains('show'), fever, feverLevel,
    ab: abActive, nova: !!skyNova, hyper: Hyper.active, banner: feverBanner.classList.contains('on') }));
  expect(s).toEqual({ boss: false, bossHud: false, fever: false, feverLevel: 0, ab: false, nova: false, hyper: false, banner: false });
  expect(errors).toEqual([]);
});
