// FREE FLIGHT: Hyperdrive is now an encounter you pilot (Dennel's brief, Nov 14: "Replace the tunnel
// with distinct, beautiful space-flight encounters... Allow movement in any direction within a roomy
// encounter area"). First environment: the ASTEROID FIELD.
//   steering: relative drag (never snaps under the finger), mouse, WASD/arrows; no drift after you stop
//   weapons: aim themselves, fire on the beat, only at what can break (debris 'S', crystal rocks 'M')
//   damage: a flight shield of 3, then 8 energy a hit (floor 1); 1.5 s protection; never the combo
//   fairness: a safe line (Flight._safe) no large rock may close: a pilot who rides it is never hit
//   quality: the same rocks, sizes and timing at every setting (only the art differs)
const { test, expect } = require('@playwright/test');
const { boot } = require('./harness');

const real = (errors) => errors.filter((e) => !/Failed to load resource/.test(e));
async function fly(page, save = {}, opts = {}) {
  const errors = await boot(page, { save: Object.assign({ level: 60, flightDone: true }, save) });
  await page.evaluate(() => startGame(false));
  await page.waitForFunction(() => state === 'playing');
  await page.waitForTimeout(600);
  await page.evaluate((opts) => {
    window.__breaks = 0; const bc = breakCombo; window.breakCombo = function () { window.__breaks++; return bc.apply(this, arguments); };
    combo = 40; window.__combo0 = combo;
    if (opts.line) window.__line = setInterval(() => { if (!Hyper.active || !Flight.main || state !== 'playing') return; const [x, y] = Flight._safe(clockNow() - startTime); Flight._set({ gx: x, gy: y, snap: true }); }, 4);
    Hyper.request();
  }, opts);
  await page.waitForFunction(() => Hyper.active && Flight.on, null, { timeout: 15000 });
  return errors;
}

test('Hyperdrive opens the ASTEROID FIELD: 30 s, free of the ring game, and back to it with the combo intact', async ({ page }) => {
  test.setTimeout(90000);
  const errors = await fly(page, {}, { line: true });
  const s0 = await page.evaluate(() => ({ flight: Hyper.flight, scene: Hyper.scene(clockNow() - startTime), title: Flight.title, notes: notes.length, body: document.body.classList.contains('hyper-on') }));
  expect(s0).toMatchObject({ flight: true, scene: true, title: 'ASTEROID FIELD', body: true });
  await page.waitForFunction(() => !Hyper.active, null, { timeout: 45000 });
  const r = await page.evaluate(() => ({ span: Hyper._span(), st: state, combo, breaks: window.__breaks, stats: Hyper.stats, shield: Flight.shield, on: Flight.on, misses: runStats.misses }));
  expect(r.span[1] - r.span[0]).toBeGreaterThan(29.9); expect(r.span[1] - r.span[0]).toBeLessThan(30.4);
  expect(r).toMatchObject({ st: 'playing', breaks: 0, on: false, shield: 3 });
  expect(r.combo).toBeGreaterThanOrEqual(40);
  expect(r.stats.crashes, 'riding the safe line: never hit').toBe(0);
  expect(r.stats.blasted, 'the guns broke debris by themselves').toBeGreaterThan(8);
  await page.waitForTimeout(2500);
  expect(await page.evaluate(() => state)).toBe('playing');
  expect(real(errors)).toEqual([]);
});

test('the safe line: every large rock of three whole flights stays off it (and rocks really do come)', async ({ page }) => {
  test.setTimeout(150000);
  const errors = await fly(page, {}, { line: true });
  const out = [];
  for (let n = 0; n < 3; n++) {
    await page.evaluate(() => { window.__min = 1e9; window.__big = new Set(); window.__near = 0;
      window.__w = setInterval(() => { if (!Flight.main) return; const s = Flight._s(); for (const o of s.rocks) if (o.k === 'L' && o.born <= clockNow() - startTime) { window.__big.add(o); const d = Math.hypot(o.x - s.cx, o.y - s.cy) - o.hr - s.G.hr; if (d < window.__min) window.__min = d; } }, 8); });
    await page.waitForFunction(() => !Hyper.active, null, { timeout: 45000 });
    out.push(await page.evaluate(() => { clearInterval(window.__w); return { min: window.__min, big: window.__big.size, crashes: Hyper.stats.crashes, U: Flight._s().G.U }; }));
    if (n < 2) { await page.waitForTimeout(700); await page.evaluate(() => { Hyper.cancel(); Hyper.request(); }); await page.waitForFunction(() => Hyper.active && Flight.on, null, { timeout: 15000 }); }   // (cancel clears the 90 s cooldown)
  }
  for (const o of out) {
    expect(o.crashes).toBe(0);
    expect(o.big, 'a real field: large rocks come').toBeGreaterThan(14);
    expect(o.min, 'never closer than a third of the craft').toBeGreaterThan(o.U * 0.3);
  }
  expect(real(errors)).toEqual([]);
});

test('damage: a large rock costs one shield and gives 1.5 s of protection; with the shield gone, 8 energy; never the combo; debris does no harm', async ({ page }) => {
  test.setTimeout(90000);
  const errors = await fly(page);
  await page.waitForFunction(() => Flight.main);
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const put = (k) => { const s = Flight._s(); const o = { k, x: s.cx, y: s.cy, vx: 0, vy: 0, r: s.G.U * 2, hr: s.G.U * 1.56, ty: 0, th: 0, spin: 0, hp: 1, inc: 0, born: 0, dead: false, passed: false, hitT: -9 }; s.rocks.push(o); return o; };
    const out = {};
    energy = 80; const d0 = put('S'); d0.r = 10; d0.hr = 8; await wait(120);
    out.debris = { shield: Flight.shield, crashes: Hyper.stats.crashes, gone: d0.dead };
    const o = put('L'); await wait(120);
    out.first = { shield: Flight.shield, crashes: Hyper.stats.crashes, energy, prot: Flight._s().protectUntil - (clockNow() - startTime) };
    await wait(600); out.protected = { shield: Flight.shield };                 // still inside the rock: protected
    await wait(1100); out.second = { shield: Flight.shield };                   // protection over: the next hit
    Flight._set({ shield: 0 }); await wait(1700);
    out.hull = { shield: Flight.shield, energy, crashes: Hyper.stats.crashes };
    energy = 5; await wait(1700); out.floor = energy;
    o.dead = true;
    return Object.assign(out, { breaks: window.__breaks, st: state, combo });
  });
  expect(r.debris).toEqual({ shield: 3, crashes: 0, gone: true });
  expect(r.first).toMatchObject({ shield: 2, crashes: 1, energy: 80 });
  expect(r.first.prot).toBeGreaterThan(1.2); expect(r.first.prot).toBeLessThanOrEqual(1.5);
  expect(r.protected.shield).toBe(2);
  expect(r.second.shield).toBe(1);
  expect(r.hull.shield).toBe(0); expect(r.hull.energy).toBeLessThanOrEqual(72);
  expect(r.floor, 'a flight never ends the run').toBeGreaterThanOrEqual(1);
  expect(r).toMatchObject({ breaks: 0, st: 'playing' });
  expect(real(errors)).toEqual([]);
});

test('steering: a drag moves the craft by the drag (it does not jump to the finger); keys fly it; it stops when you stop; it stays in the field', async ({ page, browserName }) => {
  test.setTimeout(90000);
  const errors = await fly(page);
  await page.waitForFunction(() => Flight.main);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  const s0 = await page.evaluate(() => Flight._s());
  // a finger far from the craft, dragged 60 px right and 40 px up
  const fx = 60, fy = s0.G.y0 + 40;
  await touch('touchStart', fx, fy); await page.waitForTimeout(80);
  const s1 = await page.evaluate(() => Flight._s());
  expect(Math.hypot(s1.cx - s0.cx, s1.cy - s0.cy), 'touching down moves nothing').toBeLessThan(3);
  for (let i = 1; i <= 6; i++) { await touch('touchMove', fx + i * 10, fy - i * 40 / 6); await page.waitForTimeout(16); }
  await page.waitForFunction(() => { const s = Flight._s(); return Math.hypot(s.vx, s.vy) < 6; }, null, { timeout: 2500 });   // it settles and stays (no drift)
  await page.waitForTimeout(120);
  const s2 = await page.evaluate(() => Flight._s());
  expect(s2.cx - s0.cx).toBeGreaterThan(60); expect(s2.cx - s0.cx).toBeLessThan(60 * 1.3 + 4);      // the drag, with a little gain
  expect(s0.cy - s2.cy).toBeGreaterThan(40 * 0.95);
  expect(Math.hypot(s2.cx - (fx + 60), s2.cy - (fy - 40)), 'nowhere near the finger').toBeGreaterThan(80);
  expect(Math.hypot(s2.vx, s2.vy), 'no drift once the finger stops').toBeLessThan(6);
  await touch('touchEnd', 0, 0);
  // keys: held to fly, released to stop
  await page.keyboard.down('KeyD'); await page.waitForTimeout(260); await page.keyboard.up('KeyD');
  await page.waitForFunction(() => Math.abs(Flight._s().vx) < 6, null, { timeout: 2500 });
  const s3 = await page.evaluate(() => Flight._s());
  expect(s3.cx - s2.cx).toBeGreaterThan(60);
  expect(Math.abs(s3.vx)).toBeLessThan(6);
  await page.keyboard.down('ArrowUp'); await page.waitForTimeout(200); await page.keyboard.up('ArrowUp'); await page.waitForTimeout(250);
  const s4 = await page.evaluate(() => Flight._s());
  expect(s3.cy - s4.cy).toBeGreaterThan(40);
  // the edge of the field
  await page.keyboard.down('KeyA'); await page.waitForTimeout(2500); await page.keyboard.up('KeyA'); await page.waitForTimeout(250);
  const s5 = await page.evaluate(() => Flight._s());
  expect(s5.cx).toBeGreaterThanOrEqual(s5.G.x0 - 1); expect(s5.cx).toBeLessThan(s5.G.x0 + 3);
  expect(await page.evaluate(() => ({ st: state, breaks: window.__breaks }))).toEqual({ st: 'playing', breaks: 0 });
  expect(real(errors)).toEqual([]);
});

test('pause and resume mid-flight: nothing moves while paused, the flight still lasts 30 s of game time', async ({ page }) => {
  test.setTimeout(120000);
  const errors = await fly(page, {}, { line: true });
  await page.waitForFunction(() => Flight._s().age > 8);
  await page.evaluate(() => pauseGame('test'));
  const a = await page.evaluate(() => { const s = Flight._s(); return { age: s.age, n: s.rocks.length, y: s.rocks.map((o) => o.y), st: state }; });
  await page.waitForTimeout(1500);
  const b = await page.evaluate(() => { const s = Flight._s(); return { age: s.age, n: s.rocks.length, y: s.rocks.map((o) => o.y), st: state }; });
  expect(a.st).toBe('paused'); expect(b.st).toBe('paused'); expect(b.n).toBeGreaterThan(0); expect(b.y).toEqual(a.y);
  await page.evaluate(() => requestResume());
  await page.waitForFunction(() => !Hyper.active, null, { timeout: 60000 });
  const r = await page.evaluate(() => ({ span: Hyper._span(), crashes: Hyper.stats.crashes, st: state }));
  expect(r.span[1] - r.span[0]).toBeGreaterThan(29.9); expect(r.span[1] - r.span[0]).toBeLessThan(30.5);
  expect(r).toMatchObject({ crashes: 0, st: 'playing' });
  expect(real(errors)).toEqual([]);
});

test('quality: Ultra, High, Lite and Low graphics fly the same field (same rocks, sizes and timing)', async ({ page }) => {
  test.setTimeout(150000);
  const runs = [];
  for (const [sq, low] of [['ultra', false], ['high', false], ['lite', false], ['high', true]]) {
    const errors = await boot(page, { save: { level: 60, flightDone: true, settings: { spaceQuality: sq, lowGraphics: low } } });
    await page.evaluate(() => { startGame(false); });
    await page.waitForFunction(() => state === 'playing');
    const r = await page.evaluate(async () => {
      // the same run clock and seed for each: plan 30 s of beats directly
      startTime = clockNow() - 100.5;
      const t = 100.5; Hyper.request(); Hyper.start(t); Flight._seed(4242);
      const s = Flight._s(), list = [];
      const seen = new Set();
      for (let tt = t; tt < t + 30; tt += 1 / 60) { Flight.update(1 / 60, tt); for (const o of Flight._s().rocks) if (!seen.has(o)) { seen.add(o); list.push([o.k, Math.round(o.born * 100), Math.round(o.r * 10), Math.round(o.vx), Math.round(o.vy)]); } }
      return { q: s.q, list, G: [s.G.U, s.G.hr] };
    });
    runs.push(r);
    expect(real(errors)).toEqual([]);
  }
  expect(runs.map((r) => r.q)).toEqual([3, 2, 1, 0]);
  expect(runs[0].list.length).toBeGreaterThan(40);
  for (const r of runs.slice(1)) { expect(r.list).toEqual(runs[0].list); expect(r.G).toEqual(runs[0].G); }
});

test('reduced motion: no camera follow, no close pass, no shake; the flight plays the same', async ({ page }) => {
  test.setTimeout(90000);
  await page.addInitScript(() => { const mm = window.matchMedia.bind(window); window.matchMedia = (q) => /prefers-reduced-motion/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : mm(q); });
  const errors = await fly(page);
  await page.waitForFunction(() => Flight.main);
  const r = await page.evaluate(async () => {
    const s = Flight._s(); Flight._set({ gx: s.G.x1, gy: s.G.y0 }); await new Promise((r) => setTimeout(r, 700));
    const s2 = Flight._s(); shake = 0;
    s2.rocks.push({ k: 'L', x: s2.cx, y: s2.cy, vx: 0, vy: 0, r: 60, hr: 47, ty: 0, th: 0, spin: 0, hp: 1, inc: 0, born: 0, dead: false, passed: false, hitT: -9 });
    await new Promise((r) => setTimeout(r, 150));
    return { rm: s2.rm, cam: s2.cam, moved: Math.abs(s2.cx - s.cx) > 50, shield: Flight.shield, shake };
  });
  expect(r).toEqual({ rm: true, cam: [0, 0], moved: true, shield: 2, shake: 0 });
  expect(real(errors)).toEqual([]);
});
