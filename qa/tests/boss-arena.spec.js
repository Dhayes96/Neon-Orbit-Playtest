// THE BOSS FINALE (Dennel's brief, Nov 14: "After the rhythm phase, the boss transforms and the UFO
// breaks free into an arena. Preserve the value of damage already dealt. The player dodges
// telegraphed attacks while beat-synchronized weapons target exposed weak points.")
// First boss: the Eclipse Sovereign (stage 50). In its last phase (15% health) the three-spot row
// ends and the flight begins, the boss far ahead:
//   - its health carries over exactly; every bolt on an anchor takes 0.25% of its full health
//   - the anchors are open 6 beats of every 8; the guns fire on the beat by themselves
//   - ring shards, the gaze (it locks on you) and a sweep of light; all telegraphed
//   - the flight shield of 3, then the boss's own hit cost (14): it can end the run, like any boss
//   - no rings to tap, taps judge nothing; the combo is never broken by a hit
const { test, expect } = require('@playwright/test');
const { boot } = require('./harness');

const UNLOCKS = { cubex: true, hexatron: true, triarch: true, vantaPrism: true, eclipseSovereign: true };
const real = (errors) => errors.filter((e) => !/Failed to load resource/.test(e));
async function toArena(page, { line = true } = {}) {
  const errors = await boot(page, { save: { level: 60, flightDone: true, bossUnlocks: UNLOCKS } });
  await page.evaluate(() => startGame(false));
  await page.waitForFunction(() => state === 'playing');
  await page.evaluate((line) => {
    window.__breaks = 0; const bc = breakCombo; window.breakCombo = function () { window.__breaks++; return bc.apply(this, arguments); };
    setInterval(() => { if (state === 'bossBattle' && !Flight.on && energy < 50) energy = 100; }, 50);
    if (line) setInterval(() => { if (!Flight.arena || !Flight.main || state !== 'bossBattle') return; const [x, y] = Flight._safe(clockNow() - startTime); Flight._set({ gx: x, gy: y, snap: true }); }, 4);
    hitsTotal = stageHitsNeeded(50, diff); stageUp(50);
  }, line);
  await page.waitForFunction(() => state === 'bossBattle' && !!dodge, null, { timeout: 30000 });
  await page.waitForTimeout(600);
  return errors;
}

test('the Sovereign transforms at its last phase: the row ends, the craft breaks free, and its health carries over exactly', async ({ page }) => {
  test.setTimeout(90000);
  const errors = await toArena(page);
  const r = await page.evaluate(() => {
    combo = 30; const max = bossMaxHealth, r0 = bossR();
    damageBoss(bossHealth - max * 0.5, false, true);                // phase 1: still on the row
    const mid = { arena: Flight.arena, dodge: !!dodge, phase: bossPhase };
    damageBoss(bossHealth - max * 0.14, false, true);               // into the last phase
    return { mid, max, hp: bossHealth, phase: bossPhase, arena: Flight.arena, dodge: !!dodge, st: state, notes: notes.length, title: Flight.title, r0, env: Flight._s().env, shield: Flight.shield };
  });
  expect(r.mid).toEqual({ arena: false, dodge: true, phase: 1 });
  expect(r).toMatchObject({ phase: 3, arena: true, dodge: false, st: 'bossBattle', notes: 0, title: 'THE SOVEREIGN UNBOUND', env: 'sovereign', shield: 3 });
  expect(r.hp, 'what was dealt stays dealt').toBeCloseTo(r.max * 0.14, 5);
  // the boss goes far ahead; no ring comes; a tap judges nothing
  await page.waitForFunction(() => Flight.main, null, { timeout: 10000 });
  const s = await page.evaluate(async (r0) => {
    const m0 = runStats.misses, c0 = combo; handleTap(null, true); handleTap(null, true);
    await new Promise((r) => setTimeout(r, 2500));
    return { r: bossR() / r0, by: bossY(), vy: Flight._s().G.vy, notes: notes.length, misses: runStats.misses - m0, combo: combo - c0, st: state, ability: canActivateAbility() };
  }, r.r0);
  expect(s.r, 'the boss is far ahead (smaller than on the row)').toBeLessThan(0.9);
  expect(Math.abs(s.by - s.vy), 'where everything comes from').toBeLessThan(30);
  expect(s).toMatchObject({ notes: 0, misses: 0, combo: 0, st: 'bossBattle', ability: false });
  expect(real(errors)).toEqual([]);
});

test('the arena: the guns take its anchors on the beat (0.25% a bolt, open 6 beats in 8), a pilot on the safe point is never hit, and the boss falls to the normal victory', async ({ page }) => {
  test.setTimeout(150000);
  const errors = await toArena(page);
  await page.evaluate(() => {
    combo = 30; damageBoss(bossHealth - bossMaxHealth * 0.14, false, true);
    window.__hp = []; window.__kinds = {}; window.__seen = new Set(); window.__min = 1e9; window.__open = [0, 0];
    const db = damageBoss; window.damageBoss = function (amt) { window.__hp.push(amt / bossMaxHealth); return db.apply(this, arguments); };
    setInterval(() => { if (!Flight.arena) return; const s = Flight._s(), t = clockNow() - startTime; if (Flight.main && state === 'bossBattle') window.__open[s.open ? 0 : 1]++;
      for (const o of s.rocks) { if (!window.__seen.has(o)) { window.__seen.add(o); if (!o.deco) window.__kinds[o.hz || 'rock'] = (window.__kinds[o.hz || 'rock'] || 0) + 1; }
        if (o.k === 'L' && !o.deco && (!o.aim || o.locked) && t >= o.arrive - s.win && t <= o.arrive + (o.hold || 0) + s.win) { const d = Flight._dist(o, t, s.cx, s.cy) - o.hr - s.chr; if (d < window.__min) window.__min = d; } } }, 4);
  });
  await page.waitForFunction(() => state === 'bossDefeat', null, { timeout: 120000 });
  const r = await page.evaluate(() => ({ hp: window.__hp, kinds: window.__kinds, min: window.__min, open: window.__open, crashes: Flight.stats.crashes, shield: Flight.shield, breaks: window.__breaks, arena: Flight.arena }));
  expect(r.hp.length, 'bolts on the anchors').toBeGreaterThanOrEqual(50);          // 14% at 0.25% a bolt
  for (const h of r.hp) expect(h).toBeCloseTo(0.0025, 4);
  expect(r.open[0] / (r.open[0] + r.open[1]), 'open 6 beats in 8').toBeGreaterThan(0.6);
  expect(r.open[1], 'and sealed for 2').toBeGreaterThan(0);
  expect(r.kinds.shard || 0, 'ring shards').toBeGreaterThanOrEqual(4);
  expect((r.kinds.ray || 0) + (r.kinds.sheet || 0), 'its gaze, its sweep').toBeGreaterThanOrEqual(2);
  expect(r).toMatchObject({ crashes: 0, shield: 3, breaks: 0, arena: true });
  expect(r.min).toBeGreaterThan(0.25);
  // the normal victory: on to stage 51, the flight gone, the boss unlocked as beaten
  await page.waitForFunction(() => state === 'playing' && !bossActive && !Flight.on, null, { timeout: 30000 });
  const e = await page.evaluate(() => ({ stage, st: state, on: Flight.on, combo, breaks: window.__breaks, flightN: JSON.parse(localStorage.getItem('rhythmVoidSave.v1')).flightN || 0 }));
  expect(e).toMatchObject({ stage: 51, st: 'playing', on: false, breaks: 0, flightN: 0 });       // (the finale does not use up a Hyperdrive place)
  expect(e.combo).toBeGreaterThanOrEqual(30);
  await page.waitForTimeout(2500);
  expect(await page.evaluate(() => ({ st: state, n: notes.length > 0 }))).toEqual({ st: 'playing', n: true });
  expect(real(errors)).toEqual([]);
});

test('hits in the arena: the flight shield first, then the boss\'s own cost (14); it can end the run; a hit silences the guns while the shield recovers', async ({ page }) => {
  test.setTimeout(90000);
  const errors = await toArena(page, { line: false });
  await page.evaluate(() => { damageBoss(bossHealth - bossMaxHealth * 0.14, false, true); });
  await page.waitForFunction(() => Flight.main, null, { timeout: 10000 });
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms)), out = {};
    Flight._quiet(true);
    const put = () => { const s = Flight._s(), t = clockNow() - startTime; s.rocks.push({ k: 'L', hz: 'shard', seg: [1, 0], x: s.cx, y: s.cy, vx: 0, vy: 0, r: 0.26, hr: 0.2, arrive: t + 0.03, sp: 5, born: t - 1, deco: false, n: 1, ty: 0, th: 0, spin: 0, hp: 1, inc: 0, dead: false, passed: false, hitT: -9 }); };
    energy = 100; put(); await wait(250); out.first = { shield: Flight.shield, energy };
    let n = 0; const db = damageBoss; window.damageBoss = function () { n++; return db.apply(this, arguments); };
    await wait(900); out.gunsWhileHurt = n;
    await wait(1500); out.gunsAfter = n > 0;
    Flight._set({ shield: 0 }); energy = 100; put(); await wait(250); out.hull = { shield: Flight.shield, energy, st: state };
    await wait(1600); energy = 10; put(); await wait(400); out.end = { st: state, arena: Flight.arena, on: Flight.on };
    return Object.assign(out, { breaks: window.__breaks });
  });
  expect(r.first).toEqual({ shield: 2, energy: 100 });
  expect(r.gunsWhileHurt).toBe(0);
  expect(r.gunsAfter).toBe(true);
  expect(r.hull).toEqual({ shield: 0, energy: 86, st: 'bossBattle' });
  expect(r.end).toEqual({ st: 'gameover', arena: false, on: false });
  expect(r.breaks).toBe(0);
  // and a fresh run starts clean
  await page.evaluate(() => startGame(false));
  await page.waitForFunction(() => state === 'playing');
  expect(await page.evaluate(() => ({ on: Flight.on, arena: Flight.arena }))).toEqual({ on: false, arena: false });
  expect(real(errors)).toEqual([]);
});

test('pause in the arena: nothing moves while paused; the other bosses, and the Sovereign before its last phase, are untouched', async ({ page }) => {
  test.setTimeout(90000);
  const errors = await toArena(page);
  await page.evaluate(() => damageBoss(bossHealth - bossMaxHealth * 0.14, false, true));
  await page.waitForFunction(() => Flight.main && Flight._s().rocks.length > 3, null, { timeout: 20000 });
  await page.evaluate(() => pauseGame('test'));
  const snap = () => page.evaluate(() => { const s = Flight._s(); return { arr: s.rocks.map((o) => o.arrive), th: s.rocks.map((o) => o.th), cx: s.cx, hp: bossHealth, st: state }; });
  const a = await snap(); await page.waitForTimeout(1200); const b = await snap();
  expect(a.st).toBe('paused'); expect(b).toEqual(a);
  await page.evaluate(() => requestResume());
  await page.waitForFunction(() => state === 'bossBattle', null, { timeout: 10000 });
  expect(await page.evaluate(() => Flight.arena)).toBe(true);
  // another boss at its last phase: no arena
  const errors2 = await boot(page, { save: { level: 60, flightDone: true, bossUnlocks: UNLOCKS } });
  await page.evaluate(() => { startGame(false); });
  await page.waitForFunction(() => state === 'playing');
  await page.evaluate(() => { setInterval(() => { if (energy < 50) energy = 100; }, 50); hitsTotal = stageHitsNeeded(10, diff); stageUp(10); });
  await page.waitForFunction(() => state === 'bossBattle', null, { timeout: 30000 });
  const o = await page.evaluate(() => { damageBoss(bossHealth - bossMaxHealth * 0.1, false, true); return { phase: bossPhase, arena: Flight.arena, on: Flight.on, dodge: !!dodge, id: activeBoss.id }; });
  expect(o).toEqual({ phase: 3, arena: false, on: false, dodge: true, id: 'cubex' });
  expect(real(errors.concat(errors2))).toEqual([]);
});
