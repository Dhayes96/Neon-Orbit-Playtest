// The Alien Fleet + STAR-FLEET COMMAND (Dennel, Nov 12; reworked Nov 13):
//  - Until the fleet has been beaten, MILKY WAY (the Nullstar core, once Big Bang) warps the craft to
//    the Milky Way instead of igniting. There the Alien Fleet attacks: two waves of escorts (every
//    hit fires at them; enemy fire that lands while you're on the beat is reflected, fire right after
//    a miss gets through), then THE MOTHERSHIP comes down and fights as a boss (mothership-boss.spec.js
//    covers its attacks). The player has Phantom Step for the whole thing. When the Mothership falls,
//    the Milky Way core becomes STAR-FLEET COMMAND in the same slot, then the craft warps home.
//  - STAR-FLEET COMMAND: hold to call the fleet for 12 s. In a boss fight waves of fighters take
//    station round the boss and fire on the beat; every ring you hit calls a volley; the mothership
//    joins the last wave; you still play every note. Anywhere else the fleet flies escort and shoots
//    every ring down on its beat (all PERFECT).
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { boot, writeResult } = require('./harness');

const BOSSES = { cubex: true, hexatron: true, triarch: true, vantaPrism: true, eclipseSovereign: true, metronox: true, nullstar: true };

async function start(page, ability, unlocks) {
  const errors = await boot(page, { save: { level: 60, equippedAbility: ability, bossUnlocks: unlocks } });
  await page.evaluate(() => startGame(false));
  await page.waitForFunction(() => state === 'playing');
  await page.evaluate(() => {
    const qa = window.__fl = { toasts: [], auto: true };
    qa.faults = [];                                   // every miss / stray tap (they all pass through guardBlock)
    const og = window.guardBlock;
    window.guardBlock = function (kind) { qa.faults.push({ kind, t: clockNow() - startTime }); return og.apply(this, arguments); };
    const origToast = window.showToast;
    window.showToast = function (text, color, sub) { qa.toasts.push({ text, sub, t: clockNow() - startTime }); return origToast.apply(this, arguments); };
    // a perfect player: taps every ring on its beat (keyboard path: timing only)
    setInterval(() => {
      if (!qa.auto || !(state === 'playing' || state === 'bossBattle')) return;
      const t = clockNow() - startTime;
      for (const n of notes) if (!n.hit && !n.missed && Math.abs(t - (n.hitTime + audioOffset())) < 0.03) { handleTap(null, true); break; }
    }, 8);
  });
  return errors;
}
const gameT = (page) => page.evaluate(() => clockNow() - startTime);

test('Milky Way warps to the Alien Fleet: two waves of escorts, then the Mothership as a boss; its fall makes Milky Way STAR-FLEET COMMAND', async ({ page }) => {
  test.setTimeout(180000);
  const errors = await start(page, 'bigBang', BOSSES);
  expect(await page.evaluate(() => ABILITIES.bigBang.name)).toBe('Milky Way');
  await page.waitForTimeout(2500);
  await page.evaluate(() => { abReady = true; activateAbility(); });
  const warp = await page.evaluate(() => ({ phase: Fleet.phase, state, live: notes.filter((n) => !n.hit && !n.missed).length, bang: abActive, ready: abReady }));
  expect(warp, 'Milky Way starts the jump instead of igniting').toEqual({ phase: 'warpOut', state: 'levelup', live: 0, bang: false, ready: false });

  await page.waitForFunction(() => Fleet.phase === 'fight', null, { timeout: 8000 });
  const fight = await page.evaluate(() => ({
    state, ability: abilityId, ready: abReady, hud: bossHud.classList.contains('show'),
    name: bossNameEl.textContent, sub: bossSubEl.textContent, chipHidden: stageChip.classList.contains('boss-hidden')
  }));
  expect(fight).toEqual({ state: 'playing', ability: 'phantomStep', ready: true, hud: true, name: 'ALIEN FLEET', sub: 'ESCORTS · WAVE 1 OF 2', chipHidden: true });

  // the escorts: sample waves, ships, fire, kills
  const samples = [];
  while (await page.evaluate(() => Fleet.phase === 'fight')) {
    samples.push(await page.evaluate(() => ({ wave: Fleet.wave, ships: Fleet._ships().length, bolts: Fleet._bolts().length, downed: Fleet.downed, stage, energy: Math.round(energy), sub: bossSubEl.textContent })));
    await page.waitForTimeout(500);
    if (samples.length > 70) break;
  }
  const esc = await page.evaluate(() => ({ downed: Fleet.downed, stats: Fleet.stats }));
  // the Mothership comes down
  await page.waitForFunction(() => state === 'bossBattle', null, { timeout: 12000 });
  const boss = await page.evaluate(() => ({ phase: Fleet.phase, id: activeBoss.id, name: bossNameEl.textContent, ability: abilityId, dodge: !!dodge, hp: bossHealth, max: bossMaxHealth, stage }));
  await page.waitForTimeout(6000);
  const hurt = await page.evaluate(() => bossHealth);
  // ...and falls
  await page.evaluate(() => { damageBoss(bossHealth + 1, true, true); });
  await page.waitForFunction(() => Fleet.phase === 'victory', null, { timeout: 3000 });
  const won = await page.evaluate(() => ({
    unlocked: save.bossUnlocks.fleet, saved: JSON.parse(localStorage.getItem('rhythmVoidSave.v1')).bossUnlocks.fleet,
    eqSaved: JSON.parse(localStorage.getItem('rhythmVoidSave.v1')).equippedAbility,
    label: bossRewardLabelEl.textContent, banner: bossRewardValueEl.textContent, ability: abilityId
  }));
  await page.waitForFunction(() => Fleet.phase === 'off', null, { timeout: 12000 });
  await page.waitForTimeout(300);
  const home = await page.evaluate(() => ({
    state, ability: abilityId, name: ABILITIES[abilityId].name, hud: bossHud.classList.contains('show'), chipHidden: stageChip.classList.contains('boss-hidden'),
    boss: bossActive, stage
  }));
  const qa = await page.evaluate(() => window.__fl);
  const hits = qa.toasts.filter((x) => x.text === 'HIT');
  writeResult('fleet-fight', { samples, esc, boss, hurt, won, home, hits, faults: qa.faults });

  expect([...new Set(samples.map((s) => s.wave))].sort(), 'two waves of escorts').toEqual([1, 2]);
  expect(samples.some((s) => s.sub === 'ESCORTS · WAVE 2 OF 2')).toBe(true);
  expect(Math.max(...samples.map((s) => s.ships)), 'attackers fly in').toBeGreaterThan(0);
  expect(esc.stats.fired, 'they attack').toBeGreaterThan(3);
  expect(esc.stats.reflected, 'fire that lands while you are on the beat is reflected').toBeGreaterThan(1);
  expect(esc.downed, 'hits on the beat shoot ships down').toBeGreaterThan(3);
  expect(new Set(samples.map((s) => s.stage)).size, 'no stage progress in there').toBe(1);
  expect(boss).toMatchObject({ phase: 'boss', id: 'mothership', name: 'THE MOTHERSHIP', ability: 'phantomStep', dodge: true, stage: samples[0].stage });
  expect(hurt, 'the rings you hit hurt the Mothership').toBeLessThan(boss.max);
  expect(won).toEqual({ unlocked: true, saved: true, eqSaved: 'starWarrior', label: 'MILKY WAY UPGRADED', banner: 'STAR-FLEET COMMAND', ability: 'starWarrior' });
  expect(home).toEqual({ state: 'playing', ability: 'starWarrior', name: 'Star-Fleet Command', hud: false, chipHidden: false, boss: false, stage: samples[0].stage });

  // and now, outside a boss fight, the fleet flies escort and shoots every ring down on its beat
  await page.evaluate(() => { window.__fl.auto = false; });
  const p0 = await page.evaluate(() => ({ perfects, misses: runStats.misses }));
  await page.evaluate(() => { abReady = true; activateAbility(); });
  expect(await page.evaluate(() => ({ phase: Fleet.phase, on: abActive, escorting: Fleet.escorting }))).toEqual({ phase: 'off', on: true, escorting: true });
  await page.waitForTimeout(6000);
  const p1 = await page.evaluate(() => ({ perfects, misses: runStats.misses, ships: Fleet.allyCount }));
  expect(p1.perfects - p0.perfects, 'the escort shoots the rings down (PERFECT)').toBeGreaterThan(4);
  expect(p1.misses, 'nothing missed while it escorts').toBe(p0.misses);
  expect(p1.ships, 'the escort is on station').toBeGreaterThanOrEqual(3);
  expect(errors).toEqual([]);
});

test('Fleet fire gets through only right after a slip; Phantom Step dodges it', async ({ page }) => {
  test.setTimeout(90000);
  const errors = await start(page, 'bigBang', BOSSES);
  await page.evaluate(() => setInterval(() => { energy = Math.max(energy, 60); }, 50));   // survive the test
  await page.waitForTimeout(2000);
  await page.evaluate(() => { abReady = true; activateAbility(); });
  await page.waitForFunction(() => Fleet.phase === 'fight', null, { timeout: 8000 });
  // stop playing: rings are missed, and the fleet's fire starts getting through
  await page.evaluate(() => { window.__fl.auto = false; });
  await page.waitForTimeout(9000);
  const slipping = await page.evaluate(() => ({ hits: window.__fl.toasts.filter((x) => x.text === 'HIT').length, misses: runStats.misses }));
  // now Phantom Step (lent for the fight): it dodges rings AND fire
  const t0 = await gameT(page);
  await page.evaluate(() => { activateAbility(); });
  expect(await page.evaluate(() => abActive && abilityId === 'phantomStep')).toBe(true);
  await page.waitForTimeout(7000);
  const phantom = await page.evaluate((t0) => ({ hits: window.__fl.toasts.filter((x) => x.text === 'HIT' && x.t > t0 + 0.05).length }), t0);
  writeResult('fleet-fault', { slipping, phantom });
  expect(slipping.misses, 'rings were missed').toBeGreaterThan(3);
  expect(slipping.hits, 'fire gets through after a slip').toBeGreaterThan(0);
  expect(phantom.hits, 'nothing gets through Phantom Step').toBe(0);
  // quitting mid-fight leaves nothing behind, and the fleet is still waiting next time
  await page.evaluate(() => endGame({ toMenu: true }));
  await page.waitForFunction(() => state === 'menu');
  expect(await page.evaluate(() => ({ phase: Fleet.phase, unlocked: save.bossUnlocks.fleet, ability: abilityId, eq: save.equippedAbility }))).toEqual({ phase: 'off', unlocked: false, ability: 'bigBang', eq: 'bigBang' });
  expect(errors).toEqual([]);
});

test('STAR-FLEET COMMAND in a boss fight: the fleet fights for you for 12 s (and never plays a ring)', async ({ page }) => {
  test.setTimeout(90000);
  const errors = await start(page, 'starWarrior', { ...BOSSES, fleet: true });
  await page.evaluate(() => { window.__fl.auto = false; setInterval(() => { energy = 100; }, 100); });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    window.__dmg = [];
    const orig = window.damageBoss;
    window.damageBoss = function (amount, isPerfect, fromAbility) { window.__dmg.push({ amount, t: clockNow() - startTime, ability: abActive && abilityId === 'starWarrior' }); return orig.apply(this, arguments); };
    hitsTotal = stageHitsNeeded(30, diff); stageUp(30);
  });
  await page.waitForFunction(() => state === 'bossBattle', null, { timeout: 20000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => { abReady = true; updateAbilityHud(); });
  const live = await page.evaluate(() => ({ can: canActivateAbility(), chip: abilityStatusText.textContent }));
  expect(live).toEqual({ can: true, chip: 'FLEET HOLD' });
  const before = await page.evaluate(() => ({ h: bossHealth, misses: runStats.misses, perfects, t: clockNow() - startTime }));
  await page.evaluate(() => activateAbility());
  const samples = [];
  for (let i = 0; i < 26; i++) {
    await page.waitForTimeout(500);
    samples.push(await page.evaluate(() => ({ t: clockNow() - startTime, on: abActive, ships: Fleet.allyCount, allies: Fleet.alliesOn, h: bossHealth })));
  }
  const after = await page.evaluate(() => ({ h: bossHealth, misses: runStats.misses, perfects, allies: Fleet.alliesOn, cap: tuningFor('starWarrior').bossCap }));
  const dmg = await page.evaluate(() => window.__dmg.filter((d) => d.ability).reduce((a, d) => a + d.amount, 0));
  writeResult('starwarrior-allies', { before, after, samples, dmg });
  expect(errors).toEqual([]);
  const at = (sec) => samples.find((s) => s.t - before.t >= sec) || samples[samples.length - 1];
  expect(at(2).ships, 'the first wave is on station').toBeGreaterThanOrEqual(4);
  expect(at(6).ships, 'the second wave joins').toBeGreaterThanOrEqual(8);
  expect(at(10).ships, 'and the third').toBeGreaterThanOrEqual(12);
  expect(at(11).on, 'still running at 11 s').toBe(true);
  expect(at(12.6).on, 'over after 12 s').toBe(false);
  expect(after.allies, 'and they leave').toBe(false);
  expect(dmg, 'the fleet hurts the boss').toBeGreaterThan(30);
  expect(dmg, 'within the power\'s cap').toBeLessThanOrEqual(after.cap + 0.01);
  expect(after.perfects, 'it never plays a ring for you').toBe(before.perfects);
  expect(after.misses, 'unplayed rings are still missed').toBeGreaterThan(before.misses);
});

test('STAR-FLEET COMMAND: hits call volleys; the fleet leaves when the boss falls', async ({ page }) => {
  test.setTimeout(60000);
  const errors = await start(page, 'starWarrior', { ...BOSSES, fleet: true });
  await page.evaluate(() => { setInterval(() => { energy = 100; }, 100); hitsTotal = stageHitsNeeded(20, diff); stageUp(20); });
  await page.waitForFunction(() => state === 'bossBattle', null, { timeout: 20000 });
  await page.waitForTimeout(800);
  // a perfect player (the autoplayer is on): count the squadron's shots with and without hits
  await page.evaluate(() => {
    window.__dmg = [];
    const orig = window.damageBoss;
    window.damageBoss = function (amount) { if (abActive && abilityId === 'starWarrior') window.__dmg.push({ amount, t: clockNow() - startTime }); return orig.apply(this, arguments); };
    abReady = true; activateAbility();
  });
  await page.waitForTimeout(5000);
  const withHits = await page.evaluate(() => ({ n: __dmg.length, sum: __dmg.reduce((a, d) => a + d.amount, 0), perfects }));
  // the boss falls mid-summon: the fleet goes home, nothing is left behind
  await page.evaluate(() => { bossHealth = 1; damageBoss(5, true, false); });
  await page.waitForFunction(() => !bossActive || state !== 'bossBattle', null, { timeout: 5000 });
  await page.waitForTimeout(2500);
  const end = await page.evaluate(() => ({ allies: Fleet.alliesOn, on: abActive, state }));
  writeResult('starwarrior-volleys', { withHits, end });
  expect(errors).toEqual([]);
  expect(withHits.perfects, 'the player hit rings').toBeGreaterThan(3);
  expect(withHits.n, 'beat fire plus a volley per hit').toBeGreaterThan(withHits.perfects);
  expect(end.allies, 'the fleet leaves when the boss falls').toBe(false);
});

test('Saves, settings and the CrazyGames build', async ({ page }) => {
  // an old save (no fleet key, the fleet power equipped without it) loads safely
  const errors = await boot(page, { save: { equippedAbility: 'starWarrior', bossUnlocks: BOSSES } });
  expect(await page.evaluate(() => ({ fleet: save.bossUnlocks.fleet, eq: save.equippedAbility }))).toEqual({ fleet: false, eq: 'none' });
  // before the fleet falls: Milky Way in the list, Star-Fleet Command not at all
  await page.evaluate(() => refreshSettings());
  const names = () => page.evaluate(() => [...document.querySelectorAll('#abilityGrid .ability-swatch')].map((b) => b.textContent));
  let list = await names();
  expect(list.some((t) => t.includes('Milky Way'))).toBe(true);
  expect(list.some((t) => /Big Bang|Star-Fleet|Star-Warrior/.test(t))).toBe(false);
  // after: Star-Fleet Command in its place
  await page.evaluate(() => { save.bossUnlocks.fleet = true; refreshSettings(); });
  list = await names();
  expect(list.some((t) => t.includes('Star-Fleet Command') && t.includes('The Mothership'))).toBe(true);
  expect(list.some((t) => /Milky Way|Big Bang|Star-Warrior/.test(t))).toBe(false);
  expect(errors).toEqual([]);
  // a save that beat the fleet with Milky Way still equipped loads with Star-Fleet Command
  // (the harness seeds its save on every load, so this one is put back after it)
  await page.evaluate(() => sessionStorage.setItem('__keep', JSON.stringify(Object.assign({}, save, { equippedAbility: 'bigBang', bossUnlocks: Object.assign({}, save.bossUnlocks, { fleet: true }) }))));
  await page.addInitScript(() => { const k = sessionStorage.getItem('__keep'); if (k) localStorage.setItem('rhythmVoidSave.v1', k); });
  await page.reload(); await page.waitForFunction(() => typeof save === 'object' && save.bossUnlocks);
  expect(await page.evaluate(() => save.equippedAbility)).toBe('starWarrior');

  // the CrazyGames build keeps the fleet and drops the dev warp button with the rest of dev mode
  const GAME = path.resolve(process.env.GAME_DIR || path.resolve(__dirname, '../..'));
  execFileSync(process.execPath, [path.join(GAME, 'tools', 'build-crazygames.mjs')], { cwd: GAME });
  const cg = fs.readFileSync(path.join(GAME, 'dist', 'crazygames', 'index.html'), 'utf8');
  expect(cg).toContain('const Fleet = (() =>');
  expect(cg).toContain('function summon(t, escort) {');
  expect(cg).toContain('const MOTHERSHIP_BOSS = {');
  expect(cg).not.toContain('data-dev="fleet"');
});
