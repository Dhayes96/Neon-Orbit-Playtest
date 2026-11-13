// Boss dodging + the Eclipse Sovereign redesign (Dennel, Nov 13). Prototype scope: the dodge
// system, the Sovereign's new look, arena and arrival, and its phase 1 attacks.
//  - A dodge is a beat: attacks land on a downbeat, the song leaves a gap round them (no ring
//    from 1.4 beats before to 1.4 beats after), and a counter ring follows on the next beat.
//  - Three spots (left, centre, right). A/D or the arrow keys, or a swipe, step the UFO.
//    Rings follow it. A swipe's touch-down is never a stray tap; a real stray tap still is.
//  - Step off the danger spot on a beat: PERFECT (combo +1), and the counter ring hits twice
//    as hard. Stand still: energy and one score-mode tier, never the combo.
//  - Other bosses are untouched.
const { test, expect } = require('@playwright/test');
const { boot } = require('./harness');

const UNLOCKS = { cubex: true, hexatron: true, triarch: true, vantaPrism: true };
async function toBoss(page, { stage = 50, seen = true, bot = 'tap', keepEnergy = true } = {}) {
  const errors = await boot(page, { save: { level: 60, bossUnlocks: Object.assign({}, UNLOCKS, seen ? { eclipseSovereign: true } : {}) } });
  await page.evaluate(() => startGame(false));
  await page.waitForFunction(() => state === 'playing');
  await page.evaluate(({ stage, bot, keepEnergy }) => {
    window.__breaks = 0; const bc = breakCombo; window.breakCombo = function () { window.__breaks++; return bc.apply(this, arguments); };
    window.__shots = []; const fs = fireBossShot; window.fireBossShot = function (kind, dmg) { window.__shots.push({ kind, dmg, t: clockNow() - startTime }); return fs.apply(this, arguments); };
    window.__locks = [];
    if (keepEnergy) setInterval(() => { if (energy < 50) energy = 100; }, 50);
    setInterval(() => {
      if (state !== 'bossBattle' && state !== 'playing') return;
      const t = clockNow() - startTime;
      if (bot !== 'none') for (const n of notes) if (!n.hit && !n.missed && Math.abs(t - (n.hitTime + audioOffset())) < 0.03) { handleTap(null, true); break; }
      const a = dodge && dodge.atk;
      if (a && a.locked && !a.__seen) {
        a.__seen = true;
        window.__locks.push({ kind: a.kind, danger: a.danger.slice(), st: dodge.st, lockBeats: Math.round((a.T - a.lockAt) / a.b), callBeats: Math.round((a.T - a.callAt) / a.b),
          inGap: notes.filter((n) => !n.hit && !n.missed && n !== a.note && n.hitTime > a.q0 && n.hitTime < a.q1).length,
          counterAt: a.note ? (a.note.hitTime - a.T) / a.b : null, gap: [(a.T - a.q0) / a.b, (a.q1 - a.T) / a.b] });
      }
      if (bot === 'dodge' && a && a.locked && !a.done && a.danger.includes(dodge.st) && Math.abs(t - (a.T - a.b)) < 0.03) {
        const ns = [0, 1, 2].find((i) => !a.danger.includes(i) && Math.abs(i - dodge.st) === 1);
        dodgeStep(ns - dodge.st);
      }
    }, 8);
    hitsTotal = stageHitsNeeded(stage, diff); stageUp(stage);
  }, { stage, bot, keepEnergy });
  await page.waitForFunction(() => state === 'bossIntro', null, { timeout: 15000 });
  return errors;
}
const real = (errors) => errors.filter((e) => !/Failed to load resource/.test(e));

test('arrival: the stars go out, three rings lock on beats, a held breath, then the eye opens and the fight begins', async ({ page }) => {
  test.setTimeout(60000);
  const errors = await toBoss(page, { seen: false });
  const a = await page.evaluate(() => ({ dodge: !!dodge, ecl: !!ecl, opened: ecl.opened, hud: bossHud.classList.contains('show'), ducked: music._ducking,
    locks: ecl.lock.map((x) => x - ecl.t0), open: ecl.tOpen - ecl.t0, until: bossIntroUntil - ecl.t0, b: ecl.b, fast: ecl.fast, st: dodge.st }));
  expect(a).toMatchObject({ dodge: true, ecl: true, opened: false, hud: false, ducked: true, fast: false, st: 1 });
  expect(a.locks[0]).toBeGreaterThan(1.0);                                   // the stars go out first
  expect(a.locks[1] - a.locks[0]).toBeGreaterThan(a.b * 0.9);                // each ring on its own beat
  expect(a.open - a.locks[2], 'a held breath of 4 beats before the eye').toBeGreaterThan(a.b * 3.9);
  expect(a.until).toBeGreaterThan(a.open);
  expect(a.until, 'a memorable arrival, not an endless one').toBeLessThan(12);
  await page.waitForFunction(() => ecl && ecl.opened, null, { timeout: 20000 });
  const b = await page.evaluate(() => ({ hud: bossHud.classList.contains('show'), fired: ecl.fired.slice(), ducked: music._ducking, state }));
  expect(b).toEqual({ hud: true, fired: [true, true, true], ducked: false, state: 'bossIntro' });
  await page.waitForFunction(() => state === 'bossBattle', null, { timeout: 10000 });
  await page.waitForTimeout(400);
  const c = await page.evaluate(() => ({ atSpot: Math.hypot(tgt.x - dodge.sts[1].x, tgt.y - dodge.sts[1].y) < 2, name: bossNameEl.textContent }));
  expect(c).toEqual({ atSpot: true, name: 'ECLIPSE SOVEREIGN' });
  expect(real(errors)).toEqual([]);
});

test('seen before: the arrival is shorter', async ({ page }) => {
  const errors = await toBoss(page, { seen: true });
  const a = await page.evaluate(() => ({ fast: ecl.fast, until: bossIntroUntil - ecl.t0 }));
  expect(a.fast).toBe(true);
  expect(a.until).toBeLessThan(7.5);
  expect(real(errors)).toEqual([]);
});

test('a dodge is a beat: the song leaves a gap round every attack, a counter ring follows, and dodging on the beat never costs the combo', async ({ page }) => {
  test.setTimeout(120000);
  const errors = await toBoss(page, { bot: 'dodge' });
  await page.waitForFunction(() => state === 'bossBattle', null, { timeout: 15000 });
  await page.waitForFunction(() => dodge && dodge.clean + dodge.hits >= 3, null, { timeout: 70000 });
  const r = await page.evaluate(() => ({ locks: window.__locks, hits: dodge.hits, perfects: dodge.perfects, clean: dodge.clean, breaks: window.__breaks, combo, misses: runStats.misses }));
  expect(r.locks.length).toBeGreaterThanOrEqual(3);
  expect(r.locks[0], 'the first attack of a fight is telegraphed for longer').toMatchObject({ kind: 'gaze', lockBeats: 5, callBeats: 6, danger: [1], st: 1 });
  for (const l of r.locks) {
    expect(l.inGap, 'no ring inside the gap').toBe(0);
    expect(l.counterAt, 'the counter ring is one beat after impact').toBeCloseTo(1, 2);
    expect(l.gap[0]).toBeCloseTo(1.4, 2); expect(l.gap[1]).toBeCloseTo(1.4, 2);
    expect(l.danger, 'the attack takes the spot you are standing on').toContain(l.st);
    expect(l.danger.length, 'and always leaves a way out one step away').toBe(l.kind === 'gaze' ? 1 : 2);
    expect([0, 1, 2].some((i) => !l.danger.includes(i) && Math.abs(i - l.st) === 1)).toBe(true);
  }
  expect(r.locks.slice(1).every((l) => l.lockBeats === 3 && l.callBeats === 4)).toBe(true);
  expect(r.locks.slice(0, 3).map((l) => l.kind), 'a fixed, learnable order').toEqual(['gaze', 'gaze', 'sweep']);
  expect(r).toMatchObject({ hits: 0, perfects: r.clean, breaks: 0, misses: 0 });
  expect(r.combo).toBeGreaterThan(10);
  expect(real(errors)).toEqual([]);
});

test('a perfect dodge charges the counter ring: it hits the boss twice as hard', async ({ page }) => {
  test.setTimeout(90000);
  const errors = await toBoss(page, { bot: 'dodge' });
  await page.waitForFunction(() => state === 'bossBattle', null, { timeout: 15000 });
  await page.waitForFunction(() => dodge && dodge.perfects >= 1 && dodge.clean >= 1, null, { timeout: 40000 });
  const armed = await page.evaluate(() => { const n = notes.find((x) => x.counter); return n ? { charged: !!n.charged, at: n.hitTime } : null; });
  expect(armed && armed.charged).toBe(true);
  await page.waitForFunction((at) => window.__shots.some((s) => s.t > at - 0.1 && s.t < at + 0.2), armed.at, { timeout: 10000 });
  const shot = await page.evaluate((at) => window.__shots.find((s) => s.t > at - 0.1 && s.t < at + 0.2), armed.at);
  expect(shot.dmg).toBe(10);                                                  // BOSS_DMG.perfect is 5
  expect(await page.evaluate(() => window.__shots.filter((s) => s.dmg === 5).length)).toBeGreaterThan(0);
  expect(real(errors)).toEqual([]);
});

test('standing in it: a hit costs energy and one score mode, never the combo; PERFECTs win the mode back', async ({ page }) => {
  test.setTimeout(90000);
  const errors = await toBoss(page, { bot: 'tap', keepEnergy: false });
  await page.waitForFunction(() => state === 'bossBattle', null, { timeout: 15000 });
  await page.evaluate(() => { combo = 120; comboTier = 3; setFeverLevel(2); energy = 100; setInterval(() => { if (dodge && dodge.hits === 0) energy = 100; }, 20); });
  await page.waitForFunction(() => dodge && dodge.hits >= 1, null, { timeout: 40000 });
  const r = await page.evaluate(() => ({ energy, fever, feverLevel, combo, breaks: window.__breaks, owed: tierOwed, label: document.getElementById('comboLabel').textContent }));
  expect(r.energy).toBeGreaterThan(100 - 14 - 3); expect(r.energy).toBeLessThanOrEqual(100 - 14 + 2.5);
  expect(r).toMatchObject({ fever: true, feverLevel: 1, breaks: 0, owed: 2, label: 'Fever ×1.5' });
  expect(r.combo).toBeGreaterThanOrEqual(120);
  // a run of PERFECTs brings Supernova back
  await page.evaluate(() => { for (let i = 0; i < 9; i++) notePerfect(); });
  expect(await page.evaluate(() => feverLevel), 'not before 10 in a row').toBe(1);
  await page.evaluate(() => notePerfect());
  expect(await page.evaluate(() => ({ feverLevel, owed: tierOwed }))).toEqual({ feverLevel: 2, owed: 0 });
  expect(real(errors)).toEqual([]);
});

test('controls: A/D and the arrows step; a swipe steps and is never a stray tap; a real stray tap still costs; taps in the gap are free', async ({ page }) => {
  test.setTimeout(90000);
  const errors = await toBoss(page, { bot: 'none' });
  await page.waitForFunction(() => state === 'bossBattle', null, { timeout: 15000 });
  await page.evaluate(() => { scheduleNotes = function () {}; window.scheduleNotes = scheduleNotes; notes = []; });   // an empty field: every tap here is a stray
  const st = () => page.evaluate(() => dodge.st);
  await page.keyboard.press('ArrowLeft'); expect(await st()).toBe(0);
  await page.keyboard.press('ArrowLeft'); expect(await st(), 'the row has an end').toBe(0);
  await page.keyboard.press('KeyD'); expect(await st()).toBe(1);
  await page.keyboard.press('ArrowRight'); expect(await st()).toBe(2);
  await page.keyboard.press('KeyA'); expect(await st()).toBe(1);
  await page.waitForTimeout(250);
  const follow = await page.evaluate(() => { spawnNote(clockNow() - startTime + 5, 1); return null; });
  // a swipe
  const before = await page.evaluate(() => ({ misses: runStats.misses, breaks: window.__breaks }));
  await page.mouse.move(300, 400); await page.mouse.down(); await page.mouse.move(360, 404, { steps: 3 }); await page.mouse.up();
  await page.waitForTimeout(350);
  const sw = await page.evaluate(() => ({ st: dodge.st, misses: runStats.misses, breaks: window.__breaks, ringAtUfo: notes.every((n) => Math.hypot(n.tx - tgt.x, n.ty - tgt.y) < 1), atSpot: Math.abs(tgt.x - dodge.sts[2].x) < 1 }));
  expect(sw).toEqual({ st: 2, misses: before.misses, breaks: before.breaks, ringAtUfo: true, atSpot: true });
  await page.mouse.move(360, 400); await page.mouse.down(); await page.mouse.move(300, 396, { steps: 3 }); await page.mouse.up();
  expect(await st()).toBe(1);
  // mostly vertical: not a dodge, and (no ring near) a stray tap
  await page.mouse.move(300, 400); await page.mouse.down(); await page.mouse.move(310, 470, { steps: 3 }); await page.mouse.up();
  await page.waitForTimeout(120);
  expect(await page.evaluate(() => ({ st: dodge.st, misses: runStats.misses }))).toEqual({ st: 1, misses: before.misses + 1 });
  // a finger that stays down without moving is judged after a moment
  await page.mouse.down(); await page.waitForTimeout(60);
  expect(await page.evaluate(() => runStats.misses), 'not yet').toBe(before.misses + 1);
  await page.waitForTimeout(260);
  expect(await page.evaluate(() => runStats.misses)).toBe(before.misses + 2);
  await page.mouse.up();
  // inside the song's own gap round an attack, a tap on nothing is free
  await page.waitForFunction(() => dodge.atk && (clockNow() - startTime) > dodge.atk.q0 && !dodge.atk.done, null, { timeout: 40000 });
  const m0 = await page.evaluate(() => runStats.misses);
  await page.mouse.click(300, 400); await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => runStats.misses)).toBe(m0);
  expect(real(errors)).toEqual([]);
});

test('other bosses are untouched: no dodge, no steps, stray taps as before', async ({ page }) => {
  test.setTimeout(60000);
  const errors = await toBoss(page, { stage: 40, bot: 'none' });
  expect(await page.evaluate(() => ({ dodge: !!dodge, ecl: !!ecl, hud: bossHud.classList.contains('show') }))).toEqual({ dodge: false, ecl: false, hud: true });
  await page.waitForFunction(() => state === 'bossBattle', null, { timeout: 15000 });
  const a = await page.evaluate(() => ({ x: tgt.x, misses: runStats.misses }));
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('KeyD');
  await page.evaluate(() => { notes = []; scheduleNotes = function () {}; });
  await page.mouse.move(300, 400); await page.mouse.down();
  await page.waitForTimeout(30);
  const b = await page.evaluate(() => ({ x: tgt.x, misses: runStats.misses }));
  await page.mouse.up();
  expect(b.x).toBe(a.x);
  expect(b.misses, 'judged at once, as always').toBe(a.misses + 1);
  expect(real(errors)).toEqual([]);
});

for (const [W, H] of [[390, 844], [360, 640], [844, 390], [667, 375], [768, 1024], [1280, 720]]) {
  test(`${W}x${H}: three spots a clear step apart, the Sovereign clear of the UFO, all on screen`, async ({ page }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width: W, height: H });
    const errors = await toBoss(page, { bot: 'none' });
    await page.waitForFunction(() => state === 'bossBattle', null, { timeout: 15000 });
    const L = await page.evaluate(() => ({ W, H, R: targetR, sts: dodge.sts, bx: dodge.lay.bx, by: dodge.lay.by, br: dodge.lay.r, side: dodge.lay.side, eb: document.getElementById('energyBar').getBoundingClientRect().top }));
    const [s0, s1, s2] = L.sts;
    expect(s0.x - L.R, 'left spot on screen').toBeGreaterThanOrEqual(0);
    expect(s2.x + L.R, 'right spot on screen').toBeLessThanOrEqual(L.W);
    expect(s1.x - s0.x, 'one step clears a danger spot (two 0.8R discs with a gap between them)').toBeGreaterThanOrEqual(L.R * 2.0);
    expect(s1.y + L.R, 'the row sits above the energy bar').toBeLessThanOrEqual(L.eb);
    expect(L.br, 'a boss you can read').toBeGreaterThanOrEqual(60);
    expect(L.bx - L.br * 1.39).toBeGreaterThanOrEqual(-L.br * 0.15);
    expect(L.bx + L.br * 1.39).toBeLessThanOrEqual(L.W + L.br * 0.15);
    if (L.side) expect(L.bx + L.br * 1.39, 'on its side: boss left, row right').toBeLessThanOrEqual(s0.x - L.R + 1);
    else expect(L.by + L.br * 1.15, 'stacked: boss above the row').toBeLessThanOrEqual(s1.y - L.R + 1);
    expect(real(errors)).toEqual([]);
  });
}

test('leaving the fight ends the dodge: defeat, and a fresh run', async ({ page }) => {
  test.setTimeout(60000);
  const errors = await toBoss(page, { bot: 'tap' });
  await page.waitForFunction(() => state === 'bossBattle', null, { timeout: 15000 });
  await page.evaluate(() => damageBoss(bossHealth + 1, true, true));
  await page.waitForFunction(() => !bossActive, null, { timeout: 20000 });
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => ({ dodge: !!dodge, ecl: !!ecl, ducked: music._ducking }))).toEqual({ dodge: false, ecl: false, ducked: false });
  await page.keyboard.press('ArrowLeft');
  expect(real(errors)).toEqual([]);
});
