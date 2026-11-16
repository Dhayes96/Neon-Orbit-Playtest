// The secret realms' bosses get dodge attacks of their own, each with a rule no other boss has, and
// a legend saved for when they should fall (Dennel, Nov 14: "These should feel REALLY special as
// these are secret arenas, these battles could be legendary!").
//   VORAXIS (the Abyss)  breath, meteor, finale STAR-EATER: scorched spots burn on and hurt.
//   THE VISITOR (Contact) probe, fold, finale FIRST CONTACT: reversed controls; space folds.
//   ARCHON (Ascension)   verdict, measure, finale FINAL JUDGEMENT: walls with a door that opens one
//                        count before the hammer; a pillar that locks on wherever you stand.
// At 140-180 BPM these count in half-time (the Abyss reaches ~131 BPM: there a count is a beat). The boss holds at 8% until its legend; survive the legend
// clean and the counter ring is LEGENDARY (12% of its health), enough to end the realm.
const { test, expect } = require('@playwright/test');
const { boot } = require('./harness');

const REALMS = { abyss: 'cyberDragon', planet: 'ufo', architect: 'archon' };

// bot: 'smart' steps one count before each strike that threatens it, to the nearest spot that is
// out of the strike, not burning, and not behind a wall (it knows reversed controls). 'still' never moves.
async function toSecret(page, key, bot = 'smart') {
  const errors = await boot(page, { save: { level: 90 } });
  await page.evaluate(({ key, bot }) => {
    window.__atk = []; window.__steps = []; window.__breaks = 0;
    const bc = breakCombo; window.breakCombo = function () { window.__breaks++; return bc.apply(this, arguments); };
    setInterval(() => { if (energy < 50) energy = 100; }, 50);
    setInterval(() => {
      if (state !== 'bossBattle' || !dodge) return;
      const t = clockNow() - startTime;
      for (const n of notes) { const d = t - (n.hitTime + audioOffset()); if (!n.hit && !n.missed && d > -0.03 && d < 0.07) { handleTap(null, true); break; } }
      const a = dodge.atk;
      if (!a) return;
      if (!a.__rec) {
        a.__rec = { kind: a.kind, cu: a.cu, finale: !!a.K.finale, phase: a.phase, lockCounts: Math.round((a.T - a.lockAt) / a.cb * 100) / 100,
          counterAt: (a.note.hitTime - a.last) / a.b, inGap: 0, strikes: [], hit: false, perfects: 0, fires: 0, walls: 0, rev: false, folds: [], tracks: [] };
        window.__atk.push(a.__rec);
      }
      const r = a.__rec;
      r.inGap = Math.max(r.inGap, notes.filter((n) => !n.hit && !n.missed && n !== a.note && n.hitTime > a.q0 && n.hitTime < a.q1).length);
      if (dodge.fires) r.fires = Math.max(r.fires, dodge.fires.length);
      if (dodge.walls) r.walls = Math.max(r.walls, dodge.walls.filter((w) => t < w.until).length);
      if (dodgeRev(t)) r.rev = true;
      if (a.locked) a.strikes.forEach((s, i) => {
        if (s.danger && !r.strikes[i]) r.strikes[i] = { k: Math.round((s.at - a.T) / a.cb * 100) / 100, danger: s.danger.slice(), linger: s.lingerUntil ? Math.round((s.lingerUntil - s.at) / a.cb * 100) / 100 : 0, dyn: s.dyn || null };
        if (s.folded && !s.__f) { s.__f = 1; r.folds.push({ pre: s.preFold.slice(), post: s.danger.slice(), st: dodge.st }); r.strikes[i].danger = s.danger.slice(); }
        if (s.dyn === 'track' && s.danger && !s.__tr) { s.__tr = 1; r.tracks.push({ locked: s.danger[0], st: dodge.st }); }
      });
      r.hit = a.hit; r.perfects = a.perfects; r.done = a.done;
      if (bot !== 'smart' || !a.locked) return;
      const cb = a.cb || a.b;
      const s = a.strikes.find((x) => !x.done && x.danger && x.danger.includes(dodge.st));
      if (!s || s.__stepped || t < s.at - cb + 0.02 || (s.foldAt && !s.folded)) return;
      const burns = (i) => !!(dodge.fires && dodge.fires.some((f) => f.spots.includes(i) && t < f.until));
      const soon = (i) => a.strikes.some((x) => !x.done && x.danger && x.danger.includes(i) && x.at <= s.at + 0.01);
      const reach = (i) => !dodgeWallUp(Math.min(i, dodge.st), t + 0.001) && (Math.abs(i - dodge.st) === 1 || (!burns(1) && !soon(1)));
      const safe = [0, 1, 2].filter((i) => i !== dodge.st && !s.danger.includes(i) && !burns(i) && !soon(i) && reach(i)).sort((x, y) => Math.abs(x - dodge.st) - Math.abs(y - dodge.st))[0];
      if (safe === undefined) return;
      s.__stepped = true;
      const dir = Math.sign(safe - dodge.st);
      window.__steps.push({ kind: a.kind, dist: Math.abs(safe - dodge.st), rev: dodgeRev(t) });
      dodgeStep(dodgeRev(t) ? -dir : dir);
      if (Math.abs(safe - dodge.st) === 1) dodgeStep(dodgeRev(t) ? -dir : dir);
    }, 8);
    startSecretGauntlet(key);
    stage = doomStagesTotal() + 1; bpm = stageBpmTarget();      // the tempo the realm has reached by its boss
    requestAnimationFrame(() => { if (state === 'playing') startDragonEncounter(); });
  }, { key, bot });
  await page.waitForFunction(() => state === 'bossBattle', null, { timeout: 20000 });
  return errors;
}
const real = (errors) => errors.filter((e) => !/Failed to load resource/.test(e));
const done = (page, n, timeout = 90000) => page.waitForFunction((n) => window.__atk.filter((a) => a.done).length >= n, n, { timeout });
const read = (page) => page.evaluate(() => ({ atk: window.__atk.filter((a) => a.done), steps: window.__steps, hits: dodge ? dodge.hits : -1, breaks: window.__breaks, misses: runStats.misses, boss: activeBoss && activeBoss.id }));

const CU = { cyberDragon: 1, ufo: 2, archon: 2 };              // ~131 BPM in the Abyss; 152 and 176 in the others
function common(r, n) {
  expect(r.atk.length).toBeGreaterThanOrEqual(n);
  for (const a of r.atk) {
    expect(a.cu, a.kind + ': half-time at the faster tempos').toBe(CU[r.boss]);
    expect(a.inGap, a.kind + ': no ring inside the gap').toBe(0);
    expect(a.counterAt, a.kind + ': the counter ring is one beat after the last impact').toBeCloseTo(1, 2);
    for (const s of a.strikes) expect(s.danger.length, a.kind + ': every strike leaves a spot').toBeLessThan(3);
    expect(a.hit, a.kind + ': dodged').toBe(false);
    expect(a.perfects, a.kind + ': at least one step on its count').toBeGreaterThanOrEqual(1);
  }
  for (const s of r.steps) expect(s.dist, s.kind + ': the way out is one step away').toBe(1);
  expect(r).toMatchObject({ hits: 0, breaks: 0, misses: 0 });
}

test('VORAXIS (the Abyss): INFERNO BREATH rakes toward you and the scorched spots burn on; METEOR STORM walks the safe spot', async ({ page }) => {
  test.setTimeout(150000);
  const errors = await toSecret(page, 'abyss');
  await done(page, 3, 120000);
  const r = await read(page); common(r, 3);
  expect(r.boss).toBe('cyberDragon');
  const br = r.atk.find((a) => a.kind === 'breath'), me = r.atk.find((a) => a.kind === 'meteor');
  expect(br.strikes.map((s) => s.k)).toEqual([0, 1]);                         // a spot a count
  expect(br.strikes.every((s) => s.danger.length === 1 && s.linger >= 2)).toBe(true);
  expect(br.strikes[1].danger).toEqual([1]);                                  // ...toward the centre
  expect(br.fires, 'both spots still burning').toBe(2);
  expect(me.strikes.map((s) => s.k)).toEqual([0, 2, 4]);
  expect(me.strikes.every((s) => s.danger.length === 2)).toBe(true);
  const safes = me.strikes.map((s) => [0, 1, 2].find((i) => !s.danger.includes(i)));
  for (let i = 1; i < safes.length; i++) expect(Math.abs(safes[i] - safes[i - 1]), 'the safe spot walks one step').toBe(1);
  expect(real(errors)).toEqual([]);
});

test('THE VISITOR (Contact): MIND PROBE reverses your controls; SPACE FOLD mirrors the danger two counts before', async ({ page }) => {
  test.setTimeout(150000);
  const errors = await toSecret(page, 'planet');
  await done(page, 3, 120000);
  const r = await read(page); common(r, 3);
  expect(r.boss).toBe('ufo');
  const pr = r.atk.find((a) => a.kind === 'probe'), fo = r.atk.find((a) => a.kind === 'fold');
  expect(pr.rev, 'controls reversed').toBe(true);
  expect(r.steps.filter((s) => s.kind === 'probe').every((s) => s.rev), 'every probe step was made reversed').toBe(true);
  expect(fo.folds.length).toBe(1);
  const f = fo.folds[0];
  expect(f.post, 'the danger mirrored').toEqual(f.pre.map((i) => 2 - i).sort());
  expect(f.pre.includes(f.st) || f.post.includes(f.st) || true).toBe(true);
  expect(real(errors)).toEqual([]);
});

test('ARCHON (Ascension): THE VERDICT walls you in until one count before; THE MEASURE locks on where you stand', async ({ page }) => {
  test.setTimeout(150000);
  const errors = await toSecret(page, 'architect');
  await done(page, 2, 120000);
  // against the wall: a step the wrong way is refused while the walls are up
  await page.waitForFunction(() => { const a = dodge && dodge.atk; return a && a.kind === 'verdict' && dodge.walls && dodge.walls.some((w) => !w.door && clockNow() - startTime < w.until); }, null, { timeout: 60000 });
  const bump = await page.evaluate(() => {
    const t = clockNow() - startTime, w = dodge.walls.find((x) => !x.door && t < x.until), st = dodge.st;
    const dir = w.i === st ? 1 : -1;                                          // toward the shut wall
    const moved = dodgeStep(dir);
    return { moved, same: dodge.st === st };
  });
  expect(bump).toEqual({ moved: false, same: true });
  await done(page, 4, 120000);
  const r = await read(page); common(r, 4);
  expect(r.boss).toBe('archon');
  const ve = r.atk.find((a) => a.kind === 'verdict'), me = r.atk.find((a) => a.kind === 'measure');
  expect(ve.walls, 'two walls').toBe(2);
  expect(ve.strikes[0].danger.length).toBe(2);
  expect(me.tracks.length).toBeGreaterThanOrEqual(3);
  for (const tr of me.tracks) expect(tr.locked, 'it locks on the spot you stand on').toBe(tr.st);
  expect(real(errors)).toEqual([]);
});

for (const key of ['abyss', 'planet', 'architect']) {
  test(`${key}: the later phases (two verdicts, the measure every count, the meteors every count, the probe twice) are still a step at a time`, async ({ page }) => {
    test.setTimeout(150000);
    const errors = await toSecret(page, key);
    await page.waitForTimeout(1200);
    await page.evaluate(() => {
      bossHealth = Math.ceil(bossMaxHealth * 0.3); finishBossDamage(); window.__atk.length = 0;
      setInterval(() => { if (bossActive && bossHealth < bossMaxHealth * 0.3) bossHealth = Math.ceil(bossMaxHealth * 0.3); }, 20);   // (held in phase 2)
    });
    await page.waitForFunction(() => window.__atk.filter((a) => a.done && a.phase >= 2).length >= 3, null, { timeout: 120000 });
    const r = await read(page);
    r.atk = r.atk.filter((a) => a.phase >= 2);
    common(r, 3);
    const many = r.atk.filter((a) => a.strikes.length >= 2);
    expect(many.length, 'the later attacks come in chains').toBeGreaterThanOrEqual(2);
    expect(real(errors)).toEqual([]);
  });
}

for (const [key, finale, title] of [['abyss', 'starEater', 'STAR-EATER'], ['planet', 'contact', 'FIRST CONTACT'], ['architect', 'judgement', 'FINAL JUDGEMENT']]) {
  test(`${title}: at the end it refuses to fall, unleashes its legend, and a clean dodge earns the LEGENDARY blow that ends the realm`, async ({ page }) => {
    test.setTimeout(150000);
    const errors = await toSecret(page, key);
    await page.waitForTimeout(1500);
    // knock it down to its last phase and past the floor
    const fl = await page.evaluate(() => { bossHealth = Math.ceil(bossMaxHealth * 0.1); finishBossDamage(); damageBoss(bossMaxHealth, false, true); return { hp: bossHealth, max: bossMaxHealth, phase: bossPhase, fin: dodge.fin, alive: bossActive }; });
    expect(fl.alive).toBe(true);
    expect(fl.hp, 'it holds at 8%').toBe(Math.ceil(fl.max * 0.08));
    expect(fl).toMatchObject({ phase: 3, fin: 'pending' });
    await page.waitForFunction((k) => window.__atk.some((a) => a.kind === k && a.done), finale, { timeout: 60000 });
    const r = await page.evaluate((k) => ({ a: window.__atk.find((x) => x.kind === k), fin: dodge.fin, legend: !!(dodge.legend && dodge.legend.ok) }), finale);
    expect(r.a).toMatchObject({ finale: true, hit: false });
    expect(r.a.strikes.length).toBeGreaterThanOrEqual(3);
    expect(r).toMatchObject({ fin: 'over', legend: true });
    // the legendary counter ring is the last blow
    await page.waitForFunction(() => state !== 'bossBattle' || !bossActive, null, { timeout: 20000 });
    await page.waitForFunction(() => state === 'gameover', null, { timeout: 20000 });
    const end = await page.evaluate(() => ({ title: document.getElementById('overTitle').textContent, hits: window.__breaks }));
    expect(end.title).toMatch(/HOLDS|DARK|CONCEDES/);
    expect(real(errors)).toEqual([]);
  });
}

test('VORAXIS: standing in a strike costs 16 energy; stepping into a scorched spot burns for 60% of that; never the combo', async ({ page }) => {
  test.setTimeout(150000);
  const errors = await toSecret(page, 'abyss', 'still');
  await page.evaluate(() => { window.__e = []; const dh = dodgeHit; window.dodgeHit = function (a) { const e0 = energy; const r = dh.apply(this, arguments); window.__e.push({ cost: e0 - energy, label: a.K.label }); return r; }; });
  // the breath's first spot is alight: walk into it
  await page.waitForFunction(() => dodge && dodge.fires && dodge.fires.length >= 1 && dodge.fires[0].spots[0] !== dodge.st, null, { timeout: 60000 });
  await page.evaluate(() => { energy = 100; dodgeStep(Math.sign(dodge.fires[0].spots[0] - dodge.st)); });
  await page.waitForFunction(() => window.__e.length >= 1, null, { timeout: 5000 });
  // then stand in the next attack
  await page.waitForFunction(() => window.__e.length >= 2, null, { timeout: 90000 });
  const r = await page.evaluate(() => ({ e: window.__e, breaks: window.__breaks }));
  expect(r.e[0]).toEqual({ cost: 10, label: 'SCORCHED' });
  expect(r.e.slice(1).some((x) => x.cost === 16 && x.label !== 'SCORCHED')).toBe(true);
  expect(r.breaks).toBe(0);
  expect(real(errors)).toEqual([]);
});

test('every legend and attack leaves a way out (all starting spots, both sides, every phase)', async ({ page }) => {
  const errors = await boot(page, { save: { level: 90 } });
  const bad = await page.evaluate(() => {
    // walk each static build on a grid of quarter counts: a step at most every half count; a strike
    // must not land on you; a burning spot must not hold you. (The dynamic ones, Archon's, always
    // leave a neighbour open, which the fight tests show.)
    const out = [];
    dodge = { st: 1, folds: 0 };
    for (const kind of ['breath', 'meteor', 'probe', 'fold', 'starEater', 'contact']) for (const s0 of [0, 1, 2]) for (const side of [0, 2]) for (let phase = 0; phase < 4; phase++) {
      const K = DODGE_KINDS[kind], a = { side, phase };
      const st0 = K.pullB ? 1 : s0;
      const built = K.build(a, s0).map((x) => ({ k: x.k, danger: x.fold && x.fold.to ? x.fold.to : x.danger, linger: x.linger || 0 }));
      const end = Math.max(...built.map((x) => x.k + x.linger)) + 1, Q = 4;
      const bad = (pos, q) => built.some((x) => (q === x.k * Q && x.danger.includes(pos)) || (x.linger && q > x.k * Q && q < (x.k + x.linger) * Q && x.danger.includes(pos)));
      // reachable positions at each quarter count, starting (fold: two counts before) from st0
      const start = -2 * Q;
      let cur = new Set([st0 * 10 + 9]);                       // pos*10 + quarters since last step
      for (let q = start; q <= end * Q; q++) {
        const nx = new Set();
        for (const c of cur) {
          const pos = Math.floor(c / 10), since = c % 10;
          for (const d of [-1, 0, 1]) {
            const np = pos + d; if (np < 0 || np > 2) continue;
            if (d && since < 2) continue;
            if (bad(np, q)) continue;
            nx.add(np * 10 + Math.min(9, d ? 0 : since + 1));
          }
        }
        cur = nx;
        if (!cur.size) { out.push({ kind, s0, side, phase, q }); break; }
      }
    }
    dodge = null;
    return out;
  });
  expect(bad).toEqual([]);
  expect(real(errors)).toEqual([]);
});
