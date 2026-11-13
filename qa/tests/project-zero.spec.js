// Project Zero (Dennel + Chat's brief, Nov 12):
//  - A classified briefcase appears on the main menu once the player reaches player LVL 100 OR
//    stage 100 (highest stage ever reached in a normal run). Before that: no case, no media.
//  - Opened, it shows two clearance lights, LVL 100 and STAGE 100: green when met, red when not.
//    It only opens the files with both green; otherwise "ACCESS DENIED · 1 OF 2 CLEARANCES".
//  - Granted: the PROJECT ZERO dossier, the footage (loaded only now, from separate files), then
//    ZERO FORM with Equip / Replay / Return. The reward is derived from the clearances and never
//    depends on the media: missing files, skip and close all keep it.
//  - Zero Form is a craft look (Settings → Craft) with Second Life: once per run an energy death
//    becomes a collapse that clears the screen, refills energy and keeps the combo.
//  - Saves: the highest stage is saved the moment it's reached (not in dev shortcut runs), older
//    saves are migrated from their records / Nullstar, and nothing is lowered.
const { test, expect } = require('@playwright/test');
const { boot, writeResult } = require('./harness');

async function bootZ(page, save) {
  const media = [];
  page.on('request', (r) => { if (/project-zero/.test(r.url())) media.push(r.url()); });
  const errors = await boot(page, { save });
  await page.waitForTimeout(400);
  return { errors, media };
}
const caseState = (page) => page.evaluate(() => ({
  visible: !document.getElementById('zeroCase').classList.contains('hidden'),
  armed: document.getElementById('zeroCase').classList.contains('armed')
}));

test('before LVL 100 and stage 100: no case, no media', async ({ page }) => {
  const { errors, media } = await bootZ(page, { level: 99, bestStage: 99 });
  expect(await caseState(page)).toEqual({ visible: false, armed: false });
  expect(await page.evaluate(() => document.getElementById('craftBlock').classList.contains('hidden'))).toBe(true);
  expect(media, 'the secret files are not downloaded').toEqual([]);
  expect(errors).toEqual([]);
});

for (const [name, save, lights] of [
  ['LVL 100 only', { level: 100, bestStage: 60 }, ['green', 'red']],
  ['stage 100 only', { level: 70, bestStage: 100 }, ['red', 'green']]]) {
  test(`${name}: the case shows, one light green, one red, and it stays locked`, async ({ page }) => {
    const { errors, media } = await bootZ(page, save);
    expect(await caseState(page)).toEqual({ visible: true, armed: false });
    await page.click('#zeroCase');
    await page.click('#zeroCase', { force: true }).catch(() => {});      // a second tap must not stack anything
    await page.waitForTimeout(1500);
    const r = await page.evaluate(() => ({
      overlays: document.querySelectorAll('#zeroFiles:not(.hidden)').length, phase: ZeroFiles.phase, granted: ZeroFiles.granted,
      lvl: document.getElementById('zfLightLvl').className, stage: document.getElementById('zfLightStage').className,
      status: document.getElementById('zfStatus').textContent, opened: save.zero.opened, craftBlock: document.getElementById('craftBlock').classList.contains('hidden')
    }));
    expect(r).toEqual({ overlays: 1, phase: 'case', granted: false, lvl: 'zf-light ' + lights[0], stage: 'zf-light ' + lights[1],
      status: 'ACCESS DENIED · 1 OF 2 CLEARANCES', opened: false, craftBlock: true });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => ({ open: ZeroFiles.open, state }))).toEqual({ open: false, state: 'menu' });
    expect(media, 'a locked case loads nothing').toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('both clearances: the files open, the media loads only now, Skip lands on the reward and it persists', async ({ page }) => {
  test.setTimeout(60000);
  const { errors, media } = await bootZ(page, { level: 104, bestStage: 100, settings: { music: true } });
  expect(await caseState(page)).toEqual({ visible: true, armed: true });
  expect(media, 'nothing requested before the case is opened').toEqual([]);
  await page.click('#zeroCase');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => ({ granted: ZeroFiles.granted, opened: save.zero.opened, saved: JSON.parse(localStorage.getItem('rhythmVoidSave.v1')).zero.opened }))).toEqual({ granted: true, opened: true, saved: true });
  await page.waitForTimeout(2600);
  const doc = await page.evaluate(() => ({ phase: ZeroFiles.phase, t1: document.getElementById('zfT1').textContent, t3: document.getElementById('zfT3').textContent }));
  expect(doc.phase).toBe('doc');
  expect(doc.t1).toBe('PROJECT ZERO');
  await page.waitForTimeout(1600);
  const ev = await page.evaluate(() => ({ phase: ZeroFiles.phase, msg: document.getElementById('zfEvMsg').classList.contains('hidden') ? '' : document.getElementById('zfEvMsgText').textContent,
    fit: getComputedStyle(document.getElementById('zfVideo')).objectFit, inline: document.getElementById('zfVideo').playsInline, muted: document.getElementById('zfVideo').muted }));
  expect(ev.phase).toBe('evidence');
  expect(ev.fit, 'never stretched').toBe('contain');
  expect(ev.inline).toBe(true);
  expect(ev.muted, 'no original recording audio').toBe(true);
  expect(media.some((u) => /footage\.mp4/.test(u)) && media.some((u) => /score\.m4a/.test(u)), 'footage + score requested on open').toBe(true);
  // whatever the files did, Skip lands on the reward
  await page.click('#zfSkip');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => ZeroFiles.phase)).toBe('reward');
  await page.click('#zfEquip');
  expect(await page.evaluate(() => save.craft)).toBe('zero');
  await page.click('#zfMenu');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => ({ open: ZeroFiles.open, media: ZeroFiles.media, state, armed: document.getElementById('zeroCase').classList.contains('armed') })))
    .toEqual({ open: false, media: { video: null, audio: null, failed: false, playing: false }, state: 'menu', armed: false });
  // after a reload: still equipped, the Craft picker is there, and the saucer can come back
  // (the harness seeds its save on every load, so carry the real one across the reload)
  await page.evaluate(() => sessionStorage.setItem('__pzKeep', localStorage.getItem('rhythmVoidSave.v1')));
  await page.addInitScript(() => { const k = sessionStorage.getItem('__pzKeep'); if (k) localStorage.setItem('rhythmVoidSave.v1', k); });
  await page.reload(); await page.waitForTimeout(500);
  const after = await page.evaluate(() => { showScreen('settings'); return { craft: save.craft, zero: craftIsZero(), block: document.getElementById('craftBlock').classList.contains('hidden'), n: document.querySelectorAll('#craftGrid button').length }; });
  expect(after).toEqual({ craft: 'zero', zero: true, block: false, n: 2 });
  await page.click('#craftGrid button:first-child');
  expect(await page.evaluate(() => ({ craft: save.craft, zero: craftIsZero() }))).toEqual({ craft: 'saucer', zero: false });
  expect(errors.filter((e) => !/project-zero/.test(e)), 'no page errors (a missing media file is reported, not thrown)').toEqual([]);
});

test('the footage and the score follow the files\' clock (where this browser decodes them)', async ({ page, browserName }) => {
  test.setTimeout(60000);
  const { errors } = await bootZ(page, { level: 100, bestStage: 100, settings: { music: true } });
  await page.click('#zeroCase');
  await page.waitForFunction(() => ZeroFiles.phase === 'evidence', null, { timeout: 15000 });
  await page.waitForTimeout(2500);
  const r = await page.evaluate(() => Object.assign({ clock: ZeroFiles._clock(), failed: ZeroFiles.media.failed, msg: !document.getElementById('zfEvMsg').classList.contains('hidden') }, ZeroFiles._av()));
  writeResult('project-zero-sync-' + (browserName || 'chromium'), r);
  if (r.failed || r.vReady < 2) { test.skip(true, 'this browser does not decode the footage here (the FILE DAMAGED path is covered above)'); return; }
  expect(r.msg, 'no Play File prompt with autoplay allowed').toBe(false);
  expect(r.vPaused).toBe(false);
  expect(Math.abs(r.v - (r.clock - 4)), 'footage within 0.4 s of the files\' clock').toBeLessThan(0.4);
  if (r.aReady >= 2) expect(Math.abs(r.a - r.clock), 'score within 0.4 s of the files\' clock').toBeLessThan(0.4);
  await page.click('#zfClose');
  expect(errors.filter((e) => !/project-zero/.test(e))).toEqual([]);
});

test('a missing or damaged file never costs the reward: FILE DAMAGED, then Zero Form all the same', async ({ page }) => {
  test.setTimeout(60000);
  const { errors } = await bootZ(page, { level: 100, bestStage: 100 });
  await page.evaluate(() => { ZERO.footage = 'assets/project-zero/missing.mp4'; ZERO.score = 'assets/project-zero/missing.m4a'; });
  await page.click('#zeroCase');
  await page.waitForFunction(() => ZeroFiles.phase === 'evidence', null, { timeout: 15000 });
  await page.waitForTimeout(800);
  const ev = await page.evaluate(() => ({ msg: document.getElementById('zfEvMsg').classList.contains('hidden') ? '' : document.getElementById('zfEvMsgText').textContent,
    playFile: !document.getElementById('zfPlayFile').hidden, failed: ZeroFiles.media.failed, opened: save.zero.opened }));
  expect(ev).toEqual({ msg: 'FILE DAMAGED · FOOTAGE COULD NOT BE LOADED', playFile: false, failed: true, opened: true });
  // the files' own clock keeps running: the reward arrives on time even with nothing to show
  await page.click('#zfSkip');
  await page.waitForTimeout(300);
  await page.click('#zfEquip');
  expect(await page.evaluate(() => ({ phase: ZeroFiles.phase, craft: save.craft, zero: craftIsZero() }))).toEqual({ phase: 'reward', craft: 'zero', zero: true });
  await page.click('#zfMenu');
  expect(await page.evaluate(() => ZeroFiles.media)).toEqual({ video: null, audio: null, failed: false, playing: false });
  expect(errors.filter((e) => !/project-zero|Failed to load resource/.test(e)), 'a missing file is reported on screen, not thrown').toEqual([]);
});

test('a blocked play() asks for an explicit Play File, and the files wait for it', async ({ page }) => {
  test.setTimeout(60000);
  const { errors } = await bootZ(page, { level: 100, bestStage: 100 });
  await page.evaluate(() => { window.__realPlay = HTMLVideoElement.prototype.play; HTMLVideoElement.prototype.play = function () { return Promise.reject(new DOMException('blocked', 'NotAllowedError')); }; });
  await page.click('#zeroCase');
  await page.waitForFunction(() => ZeroFiles.phase === 'evidence', null, { timeout: 15000 });
  await page.waitForTimeout(500);
  const a = await page.evaluate(() => ({ msg: document.getElementById('zfEvMsgText').textContent, shown: !document.getElementById('zfEvMsg').classList.contains('hidden'), playFile: !document.getElementById('zfPlayFile').hidden, focus: document.activeElement && document.activeElement.id, clock: ZeroFiles._clock() }));
  expect(a).toMatchObject({ msg: 'PLAYBACK BLOCKED', shown: true, playFile: true, focus: 'zfPlayFile' });
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => ZeroFiles._clock()), 'the files wait, frozen, for the tap').toBe(a.clock);
  await page.evaluate(() => { HTMLVideoElement.prototype.play = window.__realPlay; });
  await page.click('#zfPlayFile');
  await page.waitForTimeout(600);
  const b = await page.evaluate(() => ({ shown: !document.getElementById('zfEvMsg').classList.contains('hidden'), phase: ZeroFiles.phase, clock: ZeroFiles._clock() }));
  expect(b.shown).toBe(false);
  expect(b.phase).toBe('evidence');
  expect(b.clock).toBeGreaterThan(a.clock + 0.3);
  await page.keyboard.press('Escape');
  expect(errors.filter((e) => !/project-zero/.test(e))).toEqual([]);
});

test('backgrounded: the footage and score pause; back: PAUSED with Play File', async ({ page }) => {
  test.setTimeout(60000);
  const { errors } = await bootZ(page, { level: 100, bestStage: 100 });
  await page.click('#zeroCase');
  await page.waitForFunction(() => ZeroFiles.phase === 'evidence', null, { timeout: 15000 });
  await page.waitForTimeout(800);
  const hide = (h) => page.evaluate((h) => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => h }); document.dispatchEvent(new Event('visibilitychange')); }, h);
  await hide(true);
  await page.waitForTimeout(200);
  const a = await page.evaluate(() => Object.assign({ clock: ZeroFiles._clock(), playing: ZeroFiles.media.playing }, ZeroFiles._av()));
  expect(a.playing, 'score paused').toBe(false);
  expect(a.vPaused, 'footage paused').toBe(true);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => ZeroFiles._clock())).toBe(a.clock);
  await hide(false);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => ({ msg: document.getElementById('zfEvMsgText').textContent, playFile: !document.getElementById('zfPlayFile').hidden })))
    .toEqual({ msg: 'PAUSED', playFile: true });
  await page.click('#zfClose');
  expect(errors.filter((e) => !/project-zero/.test(e))).toEqual([]);
});

test('while the files are open, the menu behind them ignores keys; Escape closes; nothing lingers', async ({ page }) => {
  const { errors } = await bootZ(page, { level: 100, bestStage: 100 });
  await page.click('#zeroCase');
  await page.waitForTimeout(500);
  await page.keyboard.press('Space');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => state), 'Space/Enter did not start a run behind the files').toBe('menu');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => ({ open: ZeroFiles.open, hidden: document.getElementById('zeroFiles').classList.contains('hidden'), src: document.getElementById('zfVideo').getAttribute('src') }));
  expect(r).toEqual({ open: false, hidden: true, src: null });
  expect(errors.filter((e) => !/project-zero/.test(e))).toEqual([]);
});

test('the highest stage is saved the moment it is reached; LVL 100 from XP shows the case on the next menu visit', async ({ page }) => {
  test.setTimeout(60000);
  const { errors } = await bootZ(page, { level: 99, xp: 0, bestStage: 98 });
  await page.evaluate(() => startGame(false));
  await page.waitForFunction(() => state === 'playing');
  await page.evaluate(() => { window.breakCombo = function () {}; hitsTotal = stageHitsNeeded(100, diff); stageUp(100); });
  const mid = await page.evaluate(() => ({ best: save.bestStage, saved: JSON.parse(localStorage.getItem('rhythmVoidSave.v1')).bestStage, state, overlay: ZeroFiles.open }));
  expect(mid.best).toBe(100);
  expect(mid.saved, 'saved immediately, mid-run').toBe(100);
  expect(mid.overlay, 'the run is not interrupted').toBe(false);
  expect(mid.state).not.toBe('menu');
  // finish the run with enough XP for LVL 100
  await page.evaluate(() => { score = 2000000; energy = 0; endGame(); });
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => save.level)).toBeGreaterThanOrEqual(100);
  await page.evaluate(() => returnToMenu());
  await page.waitForTimeout(300);
  expect(await caseState(page)).toEqual({ visible: true, armed: true });
  expect(errors).toEqual([]);
});

test('older saves are migrated from Nullstar', async ({ page }) => {
  const { errors } = await bootZ(page, { level: 100, bossUnlocks: { nullstar: true } });
  expect(await page.evaluate(() => ({ best: save.bestStage, unlocked: zeroUnlocked() }))).toEqual({ best: 100, unlocked: true });
  expect(errors).toEqual([]);
});

test('older saves are migrated from their records (secret gauntlets do not count)', async ({ page }) => {
  const { errors } = await bootZ(page, { level: 40, records: { allTime: { stage: 73, score: 1 }, weekly: { key: '', rec: null }, daily: { key: '', rec: null },
    byDiff: { chill: null, arcade: { stage: 81 }, chaos: null }, secret: { abyss: { stage: 300, secret: 'abyss' }, planet: null, architect: null } } });
  expect(await page.evaluate(() => save.bestStage)).toBe(81);
  expect(errors).toEqual([]);
});

test('Second Life: once per run, an energy death becomes a collapse that keeps the combo', async ({ page }) => {
  const { errors } = await bootZ(page, { level: 100, bestStage: 100, craft: 'zero' });
  await page.evaluate(() => startGame(false));
  await page.waitForFunction(() => state === 'playing');
  await page.waitForTimeout(1500);
  const pip = await page.evaluate(() => document.querySelector('.energy-wrap').classList.contains('second-life'));
  expect(pip, 'the pip shows it is available').toBe(true);
  const r = await page.evaluate(() => {
    combo = 40; comboTier = 1; setFeverLevel(1); perfectRun = 40;
    breakCombo(); energy = 0; endGame();
    return { state, energy: Math.round(energy), combo, fever, level: feverLevel, live: notes.filter((n) => !n.hit && !n.missed).length, used: secondLifeUsed,
      pip: document.querySelector('.energy-wrap').classList.contains('second-life') };
  });
  expect(r).toEqual({ state: 'playing', energy: 100, combo: 40, fever: true, level: 1, live: 0, used: true, pip: false });
  await page.evaluate(() => { energy = 0; endGame(); });
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => state), 'only once per run').toBe('gameover');
  expect(errors).toEqual([]);
});

test('the saucer has no Second Life; dev preview changes nothing saved', async ({ page }) => {
  const { errors } = await bootZ(page, { level: 100, bestStage: 100, craft: 'saucer' });
  await page.evaluate(() => startGame(false));
  await page.waitForFunction(() => state === 'playing');
  await page.evaluate(() => { energy = 0; endGame(); });
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => state)).toBe('gameover');
  await page.evaluate(() => returnToMenu());
  await page.waitForTimeout(300);
  // preview: both lights forced green, nothing written
  await page.evaluate(() => { save.zero.opened = false; save.level = 5; save.bestStage = 5; persist(); ZeroFiles.openCase({ preview: true }); });
  await page.waitForTimeout(200);
  await page.evaluate(() => ZeroFiles.skip());
  await page.waitForTimeout(200);
  await page.click('#zfEquip');
  const r = await page.evaluate(() => ({ granted: ZeroFiles.granted, opened: save.zero.opened, craft: save.craft, session: craftIsZero(), saved: JSON.parse(localStorage.getItem('rhythmVoidSave.v1')).craft }));
  expect(r).toEqual({ granted: true, opened: false, craft: 'saucer', session: true, saved: 'saucer' });
  expect(errors.filter((e) => !/project-zero/.test(e))).toEqual([]);
});

test('reduced motion: the case opens without the zoom and lid swing, text appears without typing', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const { errors } = await bootZ(page, { level: 100, bestStage: 100 });
  await page.click('#zeroCase');
  await page.waitForTimeout(1900);
  const r = await page.evaluate(() => ({ phase: ZeroFiles.phase, lid: getComputedStyle(document.querySelector('.zf-lid')).transform, t3: document.getElementById('zfT3').textContent }));
  await ctx.close();
  expect(r.phase).toBe('doc');
  expect(r.lid).toBe('none');
  expect(r.t3).toBe('ILLINOIS // 2016');
  expect(errors.filter((e) => !/project-zero/.test(e))).toEqual([]);
});
