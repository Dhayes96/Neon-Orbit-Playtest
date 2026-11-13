// The Alien Fleet + STAR-WARRIOR (Dennel, Nov 12):
//  - Until the fleet has been beaten, BIG BANG warps the craft to the Milky Way (a galaxy in the
//    sky is locked on, the camera dives into it) instead of igniting. There the Alien Fleet attacks
//    in three waves; the player has Phantom Step for the fight. Every hit fires at the fleet;
//    enemy fire that lands while you're on the beat is reflected, fire that lands right after a
//    miss gets through. Survive and STAR-WARRIOR unlocks, then the craft warps home and the run
//    carries on. After that, Big Bang is the normal Big Bang again.
//  - STAR-WARRIOR is an equippable power: the craft is a living fireball; holding opens a portal
//    that swallows every ring (all PERFECT); when it closes the orb is charged, and the next hold
//    (or 8 s) releases everything as a full-screen blast wave that clears the field (and hits a boss).
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

test('Big Bang warps to the Alien Fleet until it is beaten; surviving unlocks STAR-WARRIOR', async ({ page }) => {
  test.setTimeout(150000);
  const errors = await start(page, 'bigBang', BOSSES);
  await page.waitForTimeout(2500);
  await page.evaluate(() => { abReady = true; activateAbility(); });
  const warp = await page.evaluate(() => ({ phase: Fleet.phase, state, live: notes.filter((n) => !n.hit && !n.missed).length, bang: abActive, ready: abReady }));
  expect(warp, 'Big Bang starts the jump instead of igniting').toEqual({ phase: 'warpOut', state: 'levelup', live: 0, bang: false, ready: false });

  await page.waitForFunction(() => Fleet.phase === 'fight', null, { timeout: 8000 });
  const fight = await page.evaluate(() => ({
    state, ability: abilityId, ready: abReady, hud: bossHud.classList.contains('show'),
    name: bossNameEl.textContent, sub: bossSubEl.textContent, chipHidden: stageChip.classList.contains('boss-hidden')
  }));
  expect(fight).toEqual({ state: 'playing', ability: 'phantomStep', ready: true, hud: true, name: 'ALIEN FLEET', sub: 'WAVE 1 OF 3', chipHidden: true });

  // the fight: sample waves, ships, fire, kills
  const samples = [];
  while (await page.evaluate(() => Fleet.phase === 'fight')) {
    samples.push(await page.evaluate(() => ({ wave: Fleet.wave, ships: Fleet._ships().length, bolts: Fleet._bolts().length, downed: Fleet.downed, stage, energy: Math.round(energy), sub: bossSubEl.textContent })));
    await page.waitForTimeout(500);
    if (samples.length > 100) break;
  }
  const won = await page.evaluate(() => ({
    phase: Fleet.phase, unlocked: save.bossUnlocks.fleet,
    saved: JSON.parse(localStorage.getItem('rhythmVoidSave.v1')).bossUnlocks.fleet,
    banner: bossRewardValueEl.textContent, downed: Fleet.downed, ability: abilityId
  }));
  await page.waitForFunction(() => Fleet.phase === 'off', null, { timeout: 8000 });
  await page.waitForTimeout(300);
  const home = await page.evaluate(() => ({
    state, ability: abilityId, ready: abReady, stagesLeft: abStagesLeft, want: tuningFor('bigBang').stages,
    hud: bossHud.classList.contains('show'), chipHidden: stageChip.classList.contains('boss-hidden'),
    chip: abilityStatus.classList.contains('show')
  }));
  const qa = await page.evaluate(() => window.__fl);
  const hits = qa.toasts.filter((x) => x.text === 'HIT');
  const beat = await page.evaluate(() => 60 / Math.max(60, bpm));
  const unexplained = hits.filter((h) => !qa.faults.some((f) => h.t - f.t >= -0.01 && h.t - f.t < beat * 1.1));
  writeResult('fleet-fight', { samples, won, home, hits, faults: qa.faults });

  expect([...new Set(samples.map((s) => s.wave))].sort(), 'three waves').toEqual([1, 2, 3]);
  expect(samples.some((s) => s.sub === 'WAVE 3 OF 3')).toBe(true);
  expect(Math.max(...samples.map((s) => s.ships)), 'attackers fly in').toBeGreaterThan(0);
  expect(samples.some((s) => s.bolts > 0), 'they fire').toBe(true);
  expect(won.downed, 'hits on the beat shoot ships down').toBeGreaterThan(8);
  // (the autoplayer is near-perfect; a rare real miss under load is allowed, but fire only ever
  // gets through right after one)
  expect(hits.length, 'staying on the beat reflects the fleet\'s fire').toBeLessThanOrEqual(qa.faults.length);
  expect(unexplained, 'fire only gets through right after a slip').toEqual([]);
  expect(qa.faults.length, 'the autoplayer stays on the beat').toBeLessThan(4);
  expect(new Set(samples.map((s) => s.stage)).size, 'no stage progress in there').toBe(1);
  expect(won).toMatchObject({ phase: 'victory', unlocked: true, saved: true, banner: 'STAR-WARRIOR', ability: 'bigBang' });
  expect(home).toEqual({ state: 'playing', ability: 'bigBang', ready: false, stagesLeft: home.want, want: home.want, hud: false, chipHidden: false, chip: true });
  expect(home.want, 'Big Bang recharging from the jump').toBeGreaterThan(0);

  // beaten: Big Bang is Big Bang again
  await page.evaluate(() => { abReady = true; activateAbility(); });
  expect(await page.evaluate(() => ({ phase: Fleet.phase, bang: abActive && abilityId === 'bigBang' }))).toEqual({ phase: 'off', bang: true });
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

test('STAR-WARRIOR: a living orb; the portal swallows every ring; the release clears the field', async ({ page }) => {
  test.setTimeout(60000);
  const errors = await start(page, 'starWarrior', { ...BOSSES, fleet: true });
  expect(await page.evaluate(() => ({ orb: starOrbOn(), name: ABILITIES.starWarrior.name }))).toEqual({ orb: true, name: 'Star-Warrior' });
  await page.evaluate(() => { window.__fl.auto = false; setInterval(() => { energy = 100; }, 100); });
  await page.waitForTimeout(2500);
  const before = await page.evaluate(() => ({ misses: runStats.misses, perfects }));
  await page.evaluate(() => { abReady = true; activateAbility(); });
  // while the portal is open nothing reaches the craft: every ring is pulled in as a PERFECT
  let maxLive = 0;
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(400);
    maxLive = Math.max(maxLive, await page.evaluate(() => { const t = clockNow() - startTime; return notes.filter((n) => !n.hit && !n.missed && noteRadius(n, t) < targetR * 3.3).length; }));
  }
  await page.waitForFunction(() => !abActive, null, { timeout: 8000 });
  const charged = await page.evaluate(() => ({ charged: starCharged, held: starHeld.length, misses: runStats.misses, perfects, chip: abilityStatusText.textContent, canHold: canActivateAbility() }));
  expect(charged.misses, 'no misses while the portal is open').toBe(before.misses);
  expect(maxLive, 'no ring gets close to the craft').toBe(0);
  expect(charged.held, 'it swallowed rings').toBeGreaterThan(4);
  expect(charged.perfects - before.perfects).toBeGreaterThanOrEqual(charged.held);
  expect(charged.charged).toBe(true);
  expect(charged.chip).toContain('RELEASE');
  expect(charged.canHold, 'a hold releases it').toBe(true);

  await page.waitForTimeout(300);
  const score0 = await page.evaluate(() => score);
  await page.evaluate(() => { abHoldStart = performance.now() - ABILITY_HOLD_MS - 10; });   // a full hold
  await page.waitForFunction(() => !starCharged, null, { timeout: 3000 });
  const blast = await page.evaluate(() => ({ blast: !!starBlast, live: notes.filter((n) => !n.hit && !n.missed).length, score, ready: abReady, chip: abilityStatusText.textContent }));
  expect(blast.blast, 'the blast wave goes off').toBe(true);
  expect(blast.live, 'and clears the field').toBe(0);
  expect(blast.score - score0, 'it pays for what it ate').toBeGreaterThanOrEqual(150 * charged.held);
  expect(blast.ready, 'releasing does not spend a recharge').toBe(false);
  expect(blast.chip).not.toContain('RELEASE');

  // left charged, it lets go on its own after 8 s
  await page.evaluate(() => { starHeld = ['#fff', '#fff']; starCharged = true; starChargeAt = clockNow() - startTime - 8.2; });
  await page.waitForFunction(() => !starCharged, null, { timeout: 3000 });
  expect(errors).toEqual([]);
});

test('STAR-WARRIOR in a boss fight: the portal and the blast both hit the boss', async ({ page }) => {
  test.setTimeout(60000);
  const errors = await start(page, 'starWarrior', { ...BOSSES, fleet: true });
  await page.evaluate(() => {
    setInterval(() => { energy = 100; }, 100);
    window.__dmg = [];
    const orig = window.damageBoss;
    window.damageBoss = function (amount, isPerfect, fromAbility) { window.__dmg.push({ amount, t: clockNow() - startTime, blast: !!starBlast }); return orig.apply(this, arguments); };
    hitsTotal = stageHitsNeeded(20, diff); stageUp(20);
  });
  await page.waitForFunction(() => state === 'bossBattle', null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { window.__fl.auto = false; abReady = true; activateAbility(); });
  await page.waitForFunction(() => !abActive, null, { timeout: 12000 });
  const held = await page.evaluate(() => starHeld.length);
  const h0 = await page.evaluate(() => bossHealth);
  await page.evaluate(() => activateAbility());
  await page.waitForTimeout(1500);
  const h1 = await page.evaluate(() => bossHealth);
  const dmg = await page.evaluate(() => window.__dmg);
  writeResult('starwarrior-boss', { held, h0, h1, dmg: dmg.length });
  expect(held).toBeGreaterThan(0);
  expect(dmg.length, 'the portal feeds the boss shots').toBeGreaterThan(0);
  expect(h0 - h1, 'the blast wave slams the boss').toBeGreaterThanOrEqual(Math.min(80, 4 * held) - 0.5);
  expect(errors).toEqual([]);
});

test('Saves, settings and the CrazyGames build', async ({ page }) => {
  // an old save (no fleet key, Star-Warrior equipped without it) loads safely
  const errors = await boot(page, { save: { equippedAbility: 'starWarrior', bossUnlocks: BOSSES } });
  expect(await page.evaluate(() => ({ fleet: save.bossUnlocks.fleet, eq: save.equippedAbility, orb: starOrbOn() }))).toEqual({ fleet: false, eq: 'none', orb: false });
  // the loadout keeps it secret until earned
  await page.evaluate(() => refreshSettings());
  const locked = await page.evaluate(() => [...document.querySelectorAll('#abilityGrid .ability-swatch')].map((b) => b.textContent).find((t) => t.includes('beyond the Big Bang')));
  expect(locked).toContain('???');
  await page.evaluate(() => { save.bossUnlocks.fleet = true; refreshSettings(); });
  const open = await page.evaluate(() => [...document.querySelectorAll('#abilityGrid .ability-swatch')].map((b) => b.textContent).find((t) => t.includes('Alien Fleet')));
  expect(open).toContain('Star-Warrior');
  expect(errors).toEqual([]);

  // the CrazyGames build keeps the fleet and drops the dev warp button with the rest of dev mode
  const GAME = path.resolve(process.env.GAME_DIR || path.resolve(__dirname, '../..'));
  execFileSync(process.execPath, [path.join(GAME, 'tools', 'build-crazygames.mjs')], { cwd: GAME });
  const cg = fs.readFileSync(path.join(GAME, 'dist', 'crazygames', 'index.html'), 'utf8');
  expect(cg).toContain('const Fleet = (() =>');
  expect(cg).toContain('function drawStarOrb(');
  expect(cg).not.toContain('data-dev="fleet"');
});
