// FREE FLIGHT: Hyperdrive is now an encounter you pilot (Dennel's brief, Nov 14: "Replace the tunnel
// with distinct, beautiful space-flight encounters... Allow movement in any direction within a roomy
// encounter area"). First environment: the ASTEROID FIELD.
//   view: a chase camera behind the craft (as the old Hyperdrive had): rocks come out of the distance
//         in perspective and pass the craft's plane on a beat; the craft is free in x and y
//   steering: relative drag (never snaps under the finger), mouse, WASD/arrows; no drift after you stop
//   weapons: aim themselves, fire on the beat, only at what can break (debris 'S', crystal rocks 'M')
//   damage: a flight shield of 3, then 8 energy a hit (floor 1); 1.5 s protection; never the combo
//   fairness: a safe point (Flight._safe) no large rock may close: a pilot who rides it is never hit
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

test('the safe point: every large rock of three whole flights stays off it (and rocks really do come, on the beat)', async ({ page }) => {
  test.setTimeout(150000);
  const errors = await fly(page, {}, { line: true });
  const out = [];
  for (let n = 0; n < 3; n++) {
    await page.evaluate(() => { window.__min = 1e9; window.__big = new Set(); window.__off = 0;
      window.__w = setInterval(() => { if (!Flight.main || state !== 'playing') return; const s = Flight._s(), t = clockNow() - startTime;
        for (const o of s.rocks) if (o.k === 'L' && !o.deco) {
          if (!window.__big.has(o)) { window.__big.add(o); const b = (o.arrive - (t - s.age)) ; window.__off = Math.max(window.__off, Math.abs(o.sp * (o.arrive - o.born) - 13)); }
          if (Math.abs(o.arrive - t) < s.win) { const [x, y] = Flight._lat(o, t), d = Math.hypot(x - s.cx, y - s.cy) - o.hr - s.chr; if (d < window.__min) window.__min = d; } } }, 4); });
    await page.waitForFunction(() => !Hyper.active, null, { timeout: 45000 });
    out.push(await page.evaluate(() => { clearInterval(window.__w); return { min: window.__min, big: window.__big.size, crashes: Hyper.stats.crashes, off: window.__off }; }));
    if (n < 2) { await page.waitForTimeout(700); await page.evaluate(() => { Hyper.cancel(); Hyper.request(); }); await page.waitForFunction(() => Hyper.active && Flight.on, null, { timeout: 15000 }); }   // (cancel clears the 90 s cooldown)
  }
  for (const o of out) {
    expect(o.crashes).toBe(0);
    expect(o.big, 'a real field: large rocks come').toBeGreaterThan(12);
    expect(o.min, 'never closer than a quarter of a unit (the craft is 0.32)').toBeGreaterThan(0.25);
    expect(o.off, 'each one crosses the whole depth of the field').toBeLessThan(0.01);
  }
  expect(real(errors)).toEqual([]);
});

test('damage: a large rock costs one shield and gives 1.5 s of protection; with the shield gone, 8 energy; never the combo; debris does no harm', async ({ page }) => {
  test.setTimeout(90000);
  const errors = await fly(page);
  await page.waitForFunction(() => Flight.main);
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // a rock that meets the craft's plane now, where the craft is
    const put = (k, r) => { const s = Flight._s(), t = clockNow() - startTime; const o = { k, x: s.cx, y: s.cy, vx: 0, vy: 0, r, hr: r * 0.78, arrive: t + 0.03, sp: 5, born: t - 1, deco: false, ty: 0, th: 0, spin: 0, hp: 1, inc: 0, dead: false, passed: false, hitT: -9 }; s.rocks.push(o); return o; };
    const out = {};
    energy = 80; const d0 = put('S', 0.2); await wait(200);
    out.debris = { shield: Flight.shield, crashes: Hyper.stats.crashes, gone: d0.dead };
    put('L', 0.7); await wait(200);
    out.first = { shield: Flight.shield, crashes: Hyper.stats.crashes, energy, prot: Flight._s().protectUntil - (clockNow() - startTime) };
    put('L', 0.7); await wait(400); out.protected = { shield: Flight.shield };  // inside the 1.5 s: nothing
    await wait(1100); put('L', 0.7); await wait(200); out.second = { shield: Flight.shield };
    Flight._set({ shield: 0 }); await wait(1600); const e0 = energy; put('L', 0.7); await wait(200);
    out.hull = { shield: Flight.shield, cost: e0 - energy, crashes: Hyper.stats.crashes };   // (a light gathered in the same moment gives 1.5 back)
    energy = 5; await wait(1600); put('L', 0.7); await wait(200); out.floor = energy;
    // a rock that passes beside the craft is no hit
    await wait(1600); const s = Flight._s(), miss = put('L', 0.5); miss.x = s.cx + 0.5 * 0.78 + s.chr + 0.1; const c0 = Hyper.stats.crashes; await wait(250);
    out.beside = Hyper.stats.crashes - c0;
    return Object.assign(out, { breaks: window.__breaks, st: state, combo });
  });
  expect(r.debris).toEqual({ shield: 3, crashes: 0, gone: true });
  expect(r.first).toMatchObject({ shield: 2, crashes: 1 }); expect(r.first.energy, 'the shield took it: no energy lost').toBeGreaterThanOrEqual(80);
  expect(r.first.prot).toBeGreaterThan(1.1); expect(r.first.prot).toBeLessThanOrEqual(1.5);
  expect(r.protected.shield).toBe(2);
  expect(r.second.shield).toBe(1);
  expect(r.hull.shield).toBe(0); expect(r.hull.cost).toBeGreaterThanOrEqual(5); expect(r.hull.cost).toBeLessThanOrEqual(8);
  expect(r.floor, 'a flight never ends the run').toBeGreaterThanOrEqual(1);
  expect(r.beside).toBe(0);
  expect(r).toMatchObject({ breaks: 0, st: 'playing' });
  expect(real(errors)).toEqual([]);
});

test('steering: a drag moves the craft by the drag (it does not jump to the finger); keys fly it; it stops when you stop; it stays in the field; the view follows', async ({ page }) => {
  test.setTimeout(90000);
  const errors = await fly(page);
  await page.waitForFunction(() => Flight.main);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  const still = () => page.waitForFunction(() => { const s = Flight._s(); return Math.hypot(s.vx, s.vy) < 0.05; }, null, { timeout: 2500 });
  const s0 = await page.evaluate(() => Flight._s());
  // a finger far from the craft, dragged 60 px right and 40 px up
  const fx = 60, fy = s0.G.top + 40;
  await touch('touchStart', fx, fy); await page.waitForTimeout(80);
  const s1 = await page.evaluate(() => Flight._s());
  expect(Math.hypot(s1.sx - s0.sx, s1.sy - s0.sy), 'touching down moves nothing').toBeLessThan(3);
  for (let i = 1; i <= 6; i++) { await touch('touchMove', fx + i * 10, fy - i * 40 / 6); await page.waitForTimeout(16); }
  await still(); await page.waitForTimeout(120);
  const s2 = await page.evaluate(() => Flight._s());
  expect(s2.sx - s0.sx).toBeGreaterThan(60); expect(s2.sx - s0.sx).toBeLessThan(60 * 1.3 + 4);      // the drag, with a little gain
  expect(s0.sy - s2.sy).toBeGreaterThan(40 * 0.95);
  expect(Math.hypot(s2.sx - (fx + 60), s2.sy - (fy - 40)), 'nowhere near the finger').toBeGreaterThan(80);
  await touch('touchEnd', 0, 0);
  // the camera follows part of the way: a rock straight ahead slides the other way on the glass
  expect(s2.cx, 'the craft flew right in the world').toBeGreaterThan(0.3);
  // keys: held to fly, released to stop
  await page.keyboard.down('KeyD'); await page.waitForTimeout(260); await page.keyboard.up('KeyD'); await still();
  const s3 = await page.evaluate(() => Flight._s());
  expect(s3.sx - s2.sx).toBeGreaterThan(40);
  await page.keyboard.down('ArrowUp'); await page.waitForTimeout(200); await page.keyboard.up('ArrowUp'); await still();
  const s4 = await page.evaluate(() => Flight._s());
  expect(s3.sy - s4.sy).toBeGreaterThan(25);
  // the edge of the field
  await page.keyboard.down('KeyA'); await page.waitForTimeout(2600); await page.keyboard.up('KeyA'); await still();
  const s5 = await page.evaluate(() => Flight._s());
  expect(s5.cx).toBeGreaterThanOrEqual(-s5.G.X - 0.01); expect(s5.cx).toBeLessThan(-s5.G.X + 0.03);
  expect(s5.sx, 'still on the glass').toBeGreaterThan(40);
  expect(await page.evaluate(() => ({ st: state, breaks: window.__breaks }))).toEqual({ st: 'playing', breaks: 0 });
  expect(real(errors)).toEqual([]);
});

test('pause and resume mid-flight: nothing changes while paused, the flight still lasts 30 s of game time', async ({ page }) => {
  test.setTimeout(120000);
  const errors = await fly(page, {}, { line: true });
  await page.waitForFunction(() => Flight._s().age > 8);
  await page.evaluate(() => pauseGame('test'));
  const snap = () => page.evaluate(() => { const s = Flight._s(); return { n: s.rocks.length, arr: s.rocks.map((o) => o.arrive), th: s.rocks.map((o) => o.th), cx: s.cx, cy: s.cy, st: state }; });
  const a = await snap(); await page.waitForTimeout(1500); const b = await snap();
  expect(a.st).toBe('paused'); expect(b.n).toBeGreaterThan(0); expect(b).toEqual(a);
  await page.evaluate(() => requestResume());
  await page.waitForFunction(() => !Hyper.active, null, { timeout: 60000 });
  const r = await page.evaluate(() => ({ span: Hyper._span(), crashes: Hyper.stats.crashes, st: state }));
  expect(r.span[1] - r.span[0]).toBeGreaterThan(29.9); expect(r.span[1] - r.span[0]).toBeLessThan(30.5);
  expect(r).toMatchObject({ crashes: 0, st: 'playing' });
  expect(real(errors)).toEqual([]);
});

test('quality: Ultra, High, Lite and Low graphics fly the same field (same rocks, sizes, places and timing; only the scenery differs)', async ({ page }) => {
  test.setTimeout(150000);
  const runs = [];
  for (const [sq, low] of [['ultra', false], ['high', false], ['lite', false], ['high', true]]) {
    const errors = await boot(page, { save: { level: 60, flightDone: true, settings: { spaceQuality: sq, lowGraphics: low } } });
    await page.evaluate(() => { startGame(false); });
    await page.waitForFunction(() => state === 'playing');
    const r = await page.evaluate(async () => {
      startTime = clockNow() - 100.5;
      const t = 100.5; Hyper.request(); Hyper.start(t); Flight._seed(4242);
      const s = Flight._s(), list = [], seen = new Set(); let deco = 0;
      for (let tt = t; tt < t + 30; tt += 1 / 60) { Flight.update(1 / 60, tt); for (const o of Flight._s().rocks) if (!seen.has(o)) { seen.add(o); if (o.deco) deco++; else list.push([o.k, Math.round(o.arrive * 100), Math.round(o.r * 100), Math.round(o.x * 100), Math.round(o.y * 100), Math.round(o.vx * 100)]); } }
      return { q: s.q, list, deco, G: [s.G.X, s.G.Yu, s.G.Yd, s.chr] };
    });
    runs.push(r);
    expect(real(errors)).toEqual([]);
  }
  expect(runs.map((r) => r.q)).toEqual([3, 2, 1, 0]);
  expect(runs[0].list.length).toBeGreaterThan(40);
  for (const r of runs.slice(1)) { expect(r.list).toEqual(runs[0].list); expect(r.G).toEqual(runs[0].G); }
  expect(runs[0].deco, 'more scenery at higher quality').toBeGreaterThan(runs[3].deco * 3);
});

test('reduced motion: no close pass on the way in, no shake; the flight plays the same', async ({ page }) => {
  test.setTimeout(90000);
  await page.addInitScript(() => { const mm = window.matchMedia.bind(window); window.matchMedia = (q) => /prefers-reduced-motion/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : mm(q); });
  const errors = await fly(page);
  const pass = await page.evaluate(() => Flight._s().rocks.filter((o) => o.deco && o.r > 2).length);
  await page.waitForFunction(() => Flight.main);
  const r = await page.evaluate(async () => {
    const s = Flight._s(); Flight._set({ gx: s.G.X, gy: -s.G.Yu }); await new Promise((r) => setTimeout(r, 700));
    const s2 = Flight._s(), t = clockNow() - startTime; shake = 0;
    s2.rocks.push({ k: 'L', x: s2.cx, y: s2.cy, vx: 0, vy: 0, r: 0.7, hr: 0.55, arrive: t + 0.03, sp: 5, born: t - 1, deco: false, ty: 0, th: 0, spin: 0, hp: 1, inc: 0, dead: false, passed: false, hitT: -9 });
    await new Promise((r) => setTimeout(r, 200));
    return { rm: s2.rm, moved: s2.sx - s.sx > 50, shield: Flight.shield, shake };
  });
  expect(pass).toBe(0);
  expect(r).toEqual({ rm: true, moved: true, shield: 2, shake: 0 });
  expect(real(errors)).toEqual([]);
});

for (const [W, H] of [[844, 390], [800, 450], [907, 510], [390, 844], [1280, 720]]) {
  test(`layout at ${W}x${H}: the craft stays on the glass and clear of the header, everywhere it can fly`, async ({ page }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width: W, height: H });
    const errors = await fly(page);
    await page.waitForFunction(() => Flight.main);
    const r = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms)), G = Flight._s().G, out = [];
      const hud = Math.max(...[...document.querySelectorAll('.hud .stat, #stagePill, #pauseBtn')].map((e) => e.getBoundingClientRect()).filter((b) => b.width).map((b) => b.bottom));
      for (const [gx, gy] of [[0, 0], [-G.X, -G.Yu], [G.X, -G.Yu], [-G.X, G.Yd], [G.X, G.Yd]]) { Flight._set({ gx, gy, snap: true }); await wait(60); const s = Flight._s(); out.push([s.sx, s.sy]); }
      return { out, hud, half: targetR * G.cs, W, H, room: [G.X * 2, G.Yu + G.Yd], bar: document.getElementById('energyBar').getBoundingClientRect().top };
    });
    for (const [x, y] of r.out) {
      expect(x - r.half * 0.9, 'inside the left edge').toBeGreaterThanOrEqual(0); expect(x + r.half * 0.9, 'inside the right edge').toBeLessThanOrEqual(r.W);
      expect(y - r.half * 0.5, 'below the header').toBeGreaterThanOrEqual(r.hud); expect(y + r.half * 0.6, 'above the energy bar').toBeLessThanOrEqual(r.bar);
    }
    expect(r.room[0], 'room to fly, side to side').toBeGreaterThanOrEqual(2.4); expect(r.room[1], 'and up and down').toBeGreaterThanOrEqual(0.9);
    expect(real(errors)).toEqual([]);
  });
}
