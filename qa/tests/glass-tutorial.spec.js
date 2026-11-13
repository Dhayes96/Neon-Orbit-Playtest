// Quick tutorial + Liquid Glass UI (Dennel, Nov 12).
//  - First-ever Start shows ONE card: a looping picture, one short line, the controls, Play.
//    No bosses or secrets named; it passes the CrazyGames bar (in view at every size, into play in
//    one tap). Play starts the run and the card never shows again.
//  - Switches still work as switches with the glass styling (keyboard + click), and the main
//    surfaces really are glass (blurred translucent background).
//  - The first power charge tells you how to fire it ("HOLD THE SAUCER").
const { test, expect } = require('@playwright/test');
const { boot, writeResult } = require('./harness');

const SIZES = [[393, 852, true], [852, 393, true], [800, 450, false], [1366, 768, false], [320, 568, true]];

for (const [w, h, touch] of SIZES) {
  test(`tutorial ${w}x${h}: one short card, Play in view, straight into the run`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: touch, hasTouch: touch });
    const page = await ctx.newPage();
    const errors = await boot(page, { save: { tutorialDone: false } });
    await page.click('#startBtn');
    await page.waitForSelector('#tutorialScreen:not(.hidden)', { timeout: 5000 });
    const card = await page.evaluate(() => {
      const scr = document.getElementById('tutorialScreen');
      const text = scr.innerText.replace(/\s+/g, ' ').trim();
      const play = document.getElementById('tutNext').getBoundingClientRect();
      const hit = document.elementFromPoint(play.left + play.width / 2, play.top + play.height / 2);
      return { text, words: text.split(' ').length, buttons: scr.querySelectorAll('button').length,
        playInView: play.top >= 0 && play.bottom <= innerHeight && play.left >= 0 && play.right <= innerWidth,
        playOnTop: !!hit && (hit.id === 'tutNext' || !!hit.closest('#tutNext')),
        cardScrolls: scr.querySelector('.card').scrollHeight > scr.querySelector('.card').clientHeight + 1 };
    });
    expect(card.buttons, 'one button: Play').toBe(1);
    expect(card.words, `short: "${card.text}"`).toBeLessThanOrEqual(16);
    expect(/boss|secret|stage|supernova|hyperdrive|singularity|core/i.test(card.text), `no spoilers: "${card.text}"`).toBe(false);
    expect(card.playInView).toBe(true);
    expect(card.playOnTop).toBe(true);
    expect(card.cardScrolls, 'no scrolling needed').toBe(false);
    await page.click('#tutNext');
    await page.waitForFunction(() => state === 'playing', null, { timeout: 8000 });
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('rhythmVoidSave.v1')).tutorialDone)).toBe(true);
    writeResult(`tutorial-${w}x${h}`, card);
    await ctx.close();
    expect(errors).toEqual([]);
  });
}

test('Liquid Glass: switches still toggle (click + keyboard), glass surfaces are translucent and blurred', async ({ page }) => {
  // (on a device that keeps the glass: Low graphics off. With Low graphics, chosen or detected as on
  // this GPU-less test machine, the blur is off by design: see sweep-fixes.spec.js)
  const errors = await boot(page, { save: { tutorialDone: true, settings: { lowGraphics: false } } });
  await page.click('#settingsBtn');
  await page.waitForSelector('#settingsScreen:not(.hidden)');
  const before = await page.evaluate(() => save.settings.sfx);
  await page.locator('#sfxToggle').scrollIntoViewIfNeeded();
  await page.click('#sfxToggle');
  expect(await page.evaluate(() => save.settings.sfx)).toBe(!before);
  await page.focus('#sfxToggle');
  await page.keyboard.press('Space');
  expect(await page.evaluate(() => save.settings.sfx)).toBe(before);
  const glass = await page.evaluate(() => {
    const bf = (el) => { const cs = getComputedStyle(el); return cs.backdropFilter || cs.webkitBackdropFilter || ''; };
    const card = document.querySelector('#settingsScreen .card');
    const tg = document.getElementById('sfxToggle');
    const thumb = getComputedStyle(tg, '::after');
    return { card: bf(card), ghost: bf(document.querySelector('.btn.ghost')), thumbW: parseFloat(thumb.width), thumbH: parseFloat(thumb.height) };
  });
  expect(glass.card).toContain('blur');
  expect(glass.ghost).toContain('blur');
  expect(glass.thumbW, 'capsule thumb').toBeGreaterThan(glass.thumbH);
  expect(errors).toEqual([]);
});

test('first power charge says how to fire it: HOLD THE SAUCER', async ({ page }) => {
  const errors = await boot(page, { save: { tutorialDone: true, level: 30, equippedAbility: 'hexSaw', bossUnlocks: { cubex: true, hexatron: true } } });
  await page.evaluate(() => startGame(false));
  await page.waitForFunction(() => state === 'playing');
  const toast = await page.evaluate(() => { abReady = false; abActive = false; abStagesLeft = 1; tickAbilityStages(false);
    return { ready: abReady, toast: document.getElementById('toast').innerText, chipReady: abilityStatus.classList.contains('ready') }; });
  expect(toast.ready).toBe(true);
  expect(toast.toast).toContain('HOLD THE SAUCER');
  expect(toast.chipReady).toBe(true);
  expect(errors).toEqual([]);
});
