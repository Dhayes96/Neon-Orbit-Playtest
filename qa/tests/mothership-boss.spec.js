// THE MOTHERSHIP (Dennel, Nov 13): the Alien Fleet's flagship is a real boss now (health, phases,
// damage from the rings you hit) with three dodge attacks of its own, on the same rules as every
// boss's (a dodge is a beat, the song leaves a gap, a counter ring follows):
//   BROADSIDE    a rolling barrage along the row, one spot per beat: step into the smoke it has left
//   TRACTOR BEAM drags the UFO under a side gun two beats before it fires: break for the centre
//   MAIN CANNON  six beats of charge, then it burns your spot and one more; it hits 1.5x as hard
const { test, expect } = require('@playwright/test');
const { boot } = require('./harness');

const ALL = { cubex: true, hexatron: true, triarch: true, vantaPrism: true, eclipseSovereign: true, metronox: true, nullstar: true };
// bot 'smart': for the next strike that would land on it, it steps on the count before (or, in a
// barrage, on the beat the strike before it lands) to a spot no strike still to come will hit.
// bot 'still': it only plays the rings.
async function toMothership(page, bot) {
  const errors = await boot(page, { save: { level: 90, bossUnlocks: ALL } });
  await page.evaluate(() => startGame(false));
  await page.waitForFunction(() => state === 'playing');
  await page.evaluate((bot) => {
    window.__atk = []; window.__steps = []; window.__drops = [];
    let lastE = 100;
    setInterval(() => { if (state === 'bossBattle' && energy < lastE) window.__drops.push({ by: Math.round(lastE - energy), kind: dodge && dodge.atk ? dodge.atk.kind : null }); if (energy < 45) energy = 100; lastE = energy; }, 20);
    setInterval(() => {
      if (state !== 'bossBattle') return;
      const t = clockNow() - startTime;
      for (const n of notes) { const d = t - (n.hitTime + audioOffset()); if (!n.hit && !n.missed && d > -0.03 && d < 0.07) { handleTap(null, true); break; } }
      const a = dodge && dodge.atk;
      if (!a) return;
      if (!a.__rec) { a.__rec = { kind: a.kind, lockBeats: Math.round((a.T - a.lockAt) / a.b), span: Math.round((a.last - a.T) / a.b * 100) / 100, side: a.side,
        gap: [(a.T - a.q0) / a.b, (a.q1 - a.last) / a.b], counterAt: (a.note.hitTime - a.last) / a.b, strikes: null, stAtLock: null, inGap: 0, pulledTo: null, hit: false, perfects: 0 }; window.__atk.push(a.__rec); }
      const r = a.__rec;
      r.inGap = Math.max(r.inGap, notes.filter((n) => !n.hit && !n.missed && n !== a.note && n.hitTime > a.q0 && n.hitTime < a.q1).length);
      if (a.locked && r.stAtLock === null) { r.stAtLock = a.from; r.strikes = a.strikes.map((s) => ({ k: Math.round((s.at - a.T) / a.b * 100) / 100, danger: s.danger.slice() })); }
      if (a.pulled && r.pulledTo === null) r.pulledTo = dodge.st;
      r.hit = a.hit; r.perfects = a.perfects; r.done = a.done;
      if (bot !== 'smart' || !a.locked) return;
      const i = a.strikes.findIndex((x) => !x.done && x.danger && x.danger.includes(dodge.st));
      if (i < 0) return;
      const s = a.strikes[i], prev = a.strikes.slice(0, i).filter((x) => !x.done);
      if (prev.length) return;                                           // the strike before it hasn't landed yet
      const p = i > 0 ? a.strikes[i - 1] : null;
      const due = p ? t >= p.at + 0.03 : Math.abs(t - (s.at - a.b)) < 0.03;
      if (!due || s.__stepped) return;
      if (a.K.pullB && !a.pulled) return;                                 // the tractor drags first
      s.__stepped = true;
      const later = a.strikes.slice(i).flatMap((x) => x.danger);
      const opts = [dodge.st - 1, dodge.st + 1].filter((x) => x >= 0 && x <= 2 && !s.danger.includes(x));
      const safe = opts.find((x) => !later.includes(x)) ?? opts[0];
      window.__steps.push({ kind: a.kind, from: dodge.st, to: safe });
      dodgeStep(Math.sign(safe - dodge.st));
    }, 8);
    startBossEncounter(stage, MOTHERSHIP_BOSS);
  }, bot);
  await page.waitForFunction(() => state === 'bossBattle', null, { timeout: 20000 });
  return errors;
}
const real = (errors) => errors.filter((e) => !/Failed to load resource/.test(e));
const done = (page, n, timeout = 120000) => page.waitForFunction((n) => window.__atk.filter((a) => a.done).length >= n, n, { timeout });

test('THE MOTHERSHIP: a real boss (health, phases, ring damage) with BROADSIDE, TRACTOR BEAM and MAIN CANNON, all dodgeable on the beat', async ({ page }) => {
  test.setTimeout(150000);
  const errors = await toMothership(page, 'smart');
  const b0 = await page.evaluate(() => ({ id: activeBoss.id, name: bossNameEl.textContent, sub: bossSubEl.textContent, hp: bossHealth, max: bossMaxHealth, dodge: !!dodge, hud: bossHud.classList.contains('show') }));
  expect(b0).toMatchObject({ id: 'mothership', name: 'THE MOTHERSHIP', sub: 'FLAGSHIP OF THE FLEET', dodge: true, hud: true });
  await done(page, 3);
  const r = await page.evaluate(() => ({ atk: window.__atk.filter((a) => a.done), steps: window.__steps, hits: dodge.hits, hp: bossHealth, max: bossMaxHealth, misses: runStats.misses }));
  expect(r.atk.slice(0, 3).map((a) => a.kind), 'its first three attacks, in order').toEqual(['broadside', 'tractor', 'cannon']);
  for (const a of r.atk) {
    expect(a.inGap, a.kind + ': no ring inside the gap').toBe(0);
    expect(a.counterAt, a.kind + ': the counter ring is one beat after the last impact').toBeCloseTo(1, 2);
    for (const s of a.strikes) expect(s.danger.length, a.kind + ': every strike leaves a spot').toBeLessThan(3);
    expect(a.hit, a.kind + ': dodged').toBe(false);
    expect(a.perfects, a.kind + ': at least one step on its count').toBeGreaterThanOrEqual(1);
  }
  const [bs, tr, cn] = r.atk;
  // BROADSIDE: one spot per beat, along the row, from the side it chose
  expect(bs.span).toBe(2);
  expect(bs.strikes).toEqual((bs.side ? [2, 1, 0] : [0, 1, 2]).map((i, k) => ({ k, danger: [i] })));
  // TRACTOR BEAM: dragged under a side gun, then the gun fires there
  expect([0, 2]).toContain(tr.pulledTo);
  expect(tr.strikes).toEqual([{ k: 0, danger: [tr.pulledTo] }]);
  // MAIN CANNON: six beats of charge (the first attack of a fight gets two more; this is the third), your spot and one more
  expect(cn.lockBeats).toBe(6);
  expect(cn.strikes[0].danger).toContain(cn.stAtLock);
  expect(cn.strikes[0].danger.length).toBe(2);
  for (const s of r.steps) expect(Math.abs(s.to - s.from), s.kind + ': one step at a time').toBe(1);
  expect(r.hits).toBe(0);
  expect(r.hp, 'the rings you hit hurt it').toBeLessThan(r.max * 0.97);
  expect(real(errors)).toEqual([]);
});

test('THE MOTHERSHIP: standing still, each attack lands (the cannon hits 1.5x as hard)', async ({ page }) => {
  test.setTimeout(150000);
  const errors = await toMothership(page, 'still');
  await done(page, 3);
  const r = await page.evaluate(() => ({ atk: window.__atk.filter((a) => a.done).map((a) => ({ kind: a.kind, hit: a.hit, stAtLock: a.stAtLock, pulledTo: a.pulledTo })), drops: window.__drops.filter((d) => d.by >= 10) }));
  const byKind = (k) => r.drops.filter((d) => d.kind === k).map((d) => d.by);
  expect(r.atk.slice(0, 3).map((a) => [a.kind, a.hit])).toEqual([['broadside', true], ['tractor', true], ['cannon', true]]);
  expect(byKind('broadside'), 'the barrage catches the centre once').toEqual([14]);
  expect(byKind('tractor'), 'dragged under the gun and hit').toEqual([14]);
  expect(byKind('cannon'), 'the main cannon: 1.5x').toEqual([21]);
  expect(real(errors)).toEqual([]);
});
