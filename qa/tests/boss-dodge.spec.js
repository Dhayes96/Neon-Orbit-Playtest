// Every boss has its own dodge attack (Dennel, Nov 13: "each boss attack mechanic should be
// unique to them"). Same rules as the Eclipse Sovereign's (qa/tests/eclipse-dodge.spec.js): a
// dodge is a beat, the song leaves a gap, a counter ring follows. What differs is what each
// attack asks of you:
//   CUBEX crush · HEXATRON signal (a played pattern, then two volleys) · TRIARCH feint (the way
//   out shows two beats before) · VANTA PRISM split (the safe spot flips between two impacts) ·
//   METRONOX slow/quick (its own half-time and double-time count) · NULLSTAR pull (gravity
//   drags you to the centre) plus the others' attacks.
const { test, expect } = require('@playwright/test');
const { boot } = require('./harness');

const ALL = { cubex: true, hexatron: true, triarch: true, vantaPrism: true, eclipseSovereign: true, metronox: true, nullstar: true, fleet: true };
// bot: 'smart' steps to the nearest safe spot one count before each strike; 'still' only taps rings
async function toBoss(page, stage, bot = 'smart') {
  const errors = await boot(page, { save: { level: 90, bossUnlocks: ALL } });
  await page.evaluate(() => startGame(false));
  await page.waitForFunction(() => state === 'playing');
  await page.evaluate(({ stage, bot }) => {
    window.__breaks = 0; const bc = breakCombo; window.breakCombo = function () { window.__breaks++; return bc.apply(this, arguments); };
    window.__atk = []; window.__steps = [];
    setInterval(() => { if (energy < 50) energy = 100; }, 50);
    setInterval(() => {
      if (state !== 'bossBattle') return;
      const t = clockNow() - startTime;
      for (const n of notes) { const d = t - (n.hitTime + audioOffset()); if (!n.hit && !n.missed && d > -0.03 && d < 0.07) { handleTap(null, true); break; } }   // (a late-ish tap still lands if a timer stalls)
      const a = dodge && dodge.atk;
      if (!a) return;
      if (!a.__rec) { a.__rec = { kind: a.kind, unit: a.unit, lockBeats: Math.round((a.T - a.lockAt) / a.b), span: Math.round((a.last - a.T) / a.b * 100) / 100, phase: a.phase,
        gap: [(a.T - a.q0) / a.b, (a.q1 - a.last) / a.b], counterAt: (a.note.hitTime - a.last) / a.b, strikes: null, stAtLock: null, inGap: 0, preDanger: undefined, revealedAt: null, pulledTo: null, hit: false, perfects: 0 }; window.__atk.push(a.__rec); }
      const r = a.__rec;
      r.inGap = Math.max(r.inGap, notes.filter((n) => !n.hit && !n.missed && n !== a.note && n.hitTime > a.q0 && n.hitTime < a.q1).length);
      if (a.locked && r.stAtLock === null) { r.stAtLock = a.from; r.preDanger = a.strikes[0].danger ? 'known' : 'hidden'; }
      if (a.locked && a.strikes.every((s) => s.danger) && !r.strikes) { r.strikes = a.strikes.map((s) => ({ k: Math.round((s.at - a.T) / a.b * 100) / 100, danger: s.danger.slice(), from: Math.round((s.from - a.T) / a.b * 100) / 100 })); r.revealedAt = (t - a.T) / a.b; r.stAtReveal = dodge.st; }
      if (a.pulled && r.pulledTo === null) r.pulledTo = dodge.st;
      r.hit = a.hit; r.perfects = a.perfects; r.done = a.done;
      if (bot === 'smart' && a.locked) {
        const s = a.strikes.find((x) => !x.done && x.danger);
        if (s && s.danger.includes(dodge.st) && Math.abs(t - (s.at - a.unit * a.b)) < 0.03 && !s.__stepped) {
          s.__stepped = true;
          const safe = [0, 1, 2].filter((i) => !s.danger.includes(i)).sort((x, y) => Math.abs(x - dodge.st) - Math.abs(y - dodge.st))[0];
          window.__steps.push({ kind: a.kind, dist: Math.abs(safe - dodge.st) });
          dodgeStep(Math.sign(safe - dodge.st));
        }
      }
    }, 8);
    startBossEncounter(stage);
  }, { stage, bot });
  await page.waitForFunction(() => state === 'bossBattle', null, { timeout: 20000 });
  return errors;
}
const real = (errors) => errors.filter((e) => !/Failed to load resource/.test(e));
const done = (page, n, timeout = 90000) => page.waitForFunction((n) => window.__atk.filter((a) => a.done).length >= n, n, { timeout });
const atk = (page) => page.evaluate(() => ({ atk: window.__atk.filter((a) => a.done), steps: window.__steps, hits: dodge.hits, breaks: window.__breaks, misses: runStats.misses, combo }));

// what holds for every boss's attacks
function common(r, n) {
  expect(r.atk.length).toBeGreaterThanOrEqual(n);
  for (const a of r.atk) {
    expect(a.inGap, a.kind + ': no ring inside the gap').toBe(0);
    expect(a.counterAt, a.kind + ': the counter ring is one beat after the last impact').toBeCloseTo(1, 2);
    expect(a.gap[1]).toBeCloseTo(1.4, 2);
    for (const s of a.strikes) expect(s.danger.length, a.kind + ': every strike leaves a spot').toBeLessThan(3);
    expect(a.hit, a.kind + ': dodged').toBe(false);
    expect(a.perfects, a.kind + ': at least one step on its count').toBeGreaterThanOrEqual(1);
  }
  for (const s of r.steps) expect(s.dist, s.kind + ': the way out is one step away').toBe(1);
  expect(r).toMatchObject({ hits: 0, breaks: 0, misses: 0 });
}

test('CUBEX (10) crush: a block falls on the spot you stand on', async ({ page }) => {
  test.setTimeout(120000);
  const errors = await toBoss(page, 10);
  await done(page, 2);
  const r = await atk(page); common(r, 2);
  expect(r.atk.map((a) => a.kind).slice(0, 2)).toEqual(['crush', 'crush']);
  expect(r.atk[0]).toMatchObject({ lockBeats: 5, span: 0, unit: 1 }); expect(r.atk[1].lockBeats).toBe(3);
  for (const a of r.atk) expect(a.strikes).toEqual([{ k: 0, danger: [a.stAtLock], from: -a.lockBeats }]);
  expect(real(errors)).toEqual([]);
});

test('HEXATRON (20) signal: it plays the pattern, then fires two volleys two beats apart, each leaving one spot a step from the last', async ({ page }) => {
  test.setTimeout(120000);
  const errors = await toBoss(page, 20);
  await done(page, 2);
  const r = await atk(page); common(r, 2);
  for (const a of r.atk.slice(0, 2)) {
    expect(a).toMatchObject({ kind: 'signal', span: 2 });
    expect(a.strikes.map((s) => s.k)).toEqual([0, 2]);
    const safe = a.strikes.map((s) => [0, 1, 2].find((i) => !s.danger.includes(i)));
    expect(Math.abs(safe[0] - a.stAtLock), 'the first safe spot is a step from where you stood').toBe(1);
    expect(Math.abs(safe[1] - safe[0]), 'and the second a step from the first').toBe(1);
    for (const s of a.strikes) expect(s.from, 'after the signal the reticle only shows for the last beat').toBeCloseTo(s.k - 1, 2);
    expect(a.gap[0]).toBeCloseTo(1.4, 2);
  }
  expect(r.atk[0].perfects, 'both steps on the beat').toBe(2);
  expect(real(errors)).toEqual([]);
});

test('TRIARCH (30) feint: all three spots are threatened; the way out shows two beats before the blades fall', async ({ page }) => {
  test.setTimeout(120000);
  const errors = await toBoss(page, 30);
  await done(page, 2);
  const r = await atk(page); common(r, 2);
  for (const a of r.atk.slice(0, 2)) {
    expect(a).toMatchObject({ kind: 'feint', preDanger: 'hidden', span: 0 });
    expect(a.revealedAt, 'revealed two beats before').toBeGreaterThanOrEqual(-2.02); expect(a.revealedAt).toBeLessThan(-1.9);
    expect(a.strikes[0].danger.length).toBe(2);
    expect(a.strikes[0].danger, 'never the spot you were on at the reveal').toContain(a.stAtReveal);
  }
  expect(real(errors)).toEqual([]);
});

test('VANTA PRISM (40) split: outer spots then the centre, or the centre then the outer spots; the safe spot flips', async ({ page }) => {
  test.setTimeout(120000);
  const errors = await toBoss(page, 40);
  await done(page, 2);
  const r = await atk(page); common(r, 2);
  const shapes = r.atk.slice(0, 2).map((a) => { expect(a).toMatchObject({ kind: 'split', span: 2 }); return JSON.stringify(a.strikes.map((s) => s.danger)); });
  expect(shapes.sort()).toEqual(['[[0,2],[1]]', '[[1],[0,2]]']);
  expect(r.atk[0].strikes.map((s) => s.k)).toEqual([0, 2]);
  expect(real(errors)).toEqual([]);
});

test('METRONOX (70) keeps its own clock: half-time, then double-time; only a step on its tick is PERFECT', async ({ page }) => {
  test.setTimeout(150000);
  const errors = await toBoss(page, 70);
  await done(page, 2, 120000);
  const r = await atk(page); common(r, 2);
  expect(r.atk[0]).toMatchObject({ kind: 'slow', unit: 2, lockBeats: 8 });
  expect(r.atk[0].gap[0], 'the gap opens before its half-time tick').toBeCloseTo(2.4, 2);
  expect(r.atk[0].strikes[0].danger.length).toBe(2);
  expect(r.atk[1]).toMatchObject({ kind: 'quick', unit: 0.5, lockBeats: 2 });
  expect(r.atk[1].strikes[0].danger).toEqual([r.atk[1].stAtLock]);
  // on the song's beat, off Metronox's half-time tick: safe, but not PERFECT
  await page.waitForFunction(() => dodge.atk && dodge.atk.kind === 'slow' && dodge.atk.locked, null, { timeout: 60000 });
  await page.evaluate(() => { window.__noSmart = true; });
  const res = await page.evaluate(() => new Promise((resolve) => {
    const a = dodge.atk, s = a.strikes[0]; s.__stepped = true;
    const iv = setInterval(() => {
      const t = clockNow() - startTime;
      if (t >= s.at - a.b - 0.01) { clearInterval(iv); const safe = [0, 1, 2].find((i) => !s.danger.includes(i)); const p0 = dodge.perfects; dodgeStep(Math.sign(safe - dodge.st)); resolve({ perfectsAdded: dodge.perfects - p0, safe: !s.danger.includes(dodge.st) }); }
    }, 4);
  }));
  expect(res).toEqual({ perfectsAdded: 0, safe: true });
  expect(real(errors)).toEqual([]);
});

test('NULLSTAR (100) pull: gravity drags the UFO to the centre two beats before the centre collapses; then it borrows the others', async ({ page }) => {
  test.setTimeout(150000);
  const errors = await toBoss(page, 100);
  await page.evaluate(() => dodgeStep(-1));                                   // start off-centre
  await done(page, 2, 120000);
  const r = await atk(page); common(r, 2);
  expect(r.atk[0]).toMatchObject({ kind: 'pull', pulledTo: 1 });
  expect(r.atk[0].strikes.map((s) => s.danger)).toEqual([[1]]);
  expect(r.atk[1].kind, 'Cubex\'s block, in the void').toBe('crush');
  expect(real(errors)).toEqual([]);
});

for (const [stage, name, cost] of [[10, 'CUBEX', 10], [20, 'HEXATRON', 12], [30, 'TRIARCH', 12], [40, 'VANTA PRISM', 14], [70, 'METRONOX', 14], [100, 'NULLSTAR', 16]]) {
  test(`${name}: standing still is a hit that costs ${cost} energy, never the combo`, async ({ page }) => {
    test.setTimeout(120000);
    const errors = await toBoss(page, stage, 'still');
    await page.evaluate(() => { window.__e = []; const dh = dodgeHit; window.dodgeHit = function (a) { const e0 = energy; const r = dh.apply(this, arguments); window.__e.push(e0 - energy); return r; }; });
    await page.waitForFunction(() => dodge && dodge.hits >= 1, null, { timeout: 90000 });
    const r = await page.evaluate(() => ({ cost: window.__e[0], breaks: window.__breaks, name: bossNameEl.textContent, toast: document.getElementById('toast') ? document.getElementById('toast').textContent : '' }));
    expect(r.cost).toBeCloseTo(cost, 5);
    expect(r).toMatchObject({ breaks: 0, name });
    expect(real(errors)).toEqual([]);
  });
}

test('the Alien Fleet: its escort waves are not a dodge fight; the Mothership is (mothership-boss.spec.js)', async ({ page }) => {
  const errors = await boot(page, { save: { level: 90, bossUnlocks: ALL } });
  expect(await page.evaluate(() => Object.keys(DODGE_BOSSES).sort())).toEqual(['cubex', 'eclipseSovereign', 'hexatron', 'metronox', 'mothership', 'nullstar', 'triarch', 'vantaPrism']);
  expect(await page.evaluate(() => DODGE_BOSSES.mothership.pools.flat().filter((k, i, a) => a.indexOf(k) === i).sort())).toEqual(['broadside', 'cannon', 'tractor']);
  expect(real(errors)).toEqual([]);
});
