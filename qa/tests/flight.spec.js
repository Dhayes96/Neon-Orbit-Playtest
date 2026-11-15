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

test('a different place each Hyperdrive: the Asteroid Field, the Living Nebula, the Alien Ruins, and round again', async ({ page }) => {
  test.setTimeout(60000);
  const errors = await fly(page);
  const seen = [await page.evaluate(() => Flight.title)];
  for (let n = 0; n < 3; n++) {
    await page.evaluate(() => { Flight.end(); Hyper.cancel(); Hyper.request(); });      // (as a finished flight leaves it; cancel clears the 90 s cooldown)
    await page.waitForFunction(() => Hyper.active && Flight.on, null, { timeout: 15000 });
    seen.push(await page.evaluate(() => Flight.title));
  }
  expect(seen).toEqual(['ASTEROID FIELD', 'LIVING NEBULA', 'ALIEN RUINS', 'ASTEROID FIELD']);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('rhythmVoidSave.v1')).flightN)).toBe(3);
  expect(real(errors)).toEqual([]);
});

// what each place must send in a flight (hazards by kind), with a pilot on the safe point never hit
const PLACES = { asteroids: { rock: 12 }, nebula: { arc: 6, cell: 2 }, ruins: { beam: 3, sheet: 1, pulse: 1 } };
for (const [env, need] of Object.entries(PLACES)) {
  test(`the safe point in the ${env}: every hazard of a whole flight stays off it (bars, sweeps and pulses included)`, async ({ page }) => {
    test.setTimeout(90000);
    const errors = await boot(page, { save: { level: 60, flightDone: true } });
    await page.evaluate((env) => { Flight._env(env); startGame(false); }, env);
    await page.waitForFunction(() => state === 'playing');
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      window.__min = 1e9; window.__seen = new Set(); window.__n = {}; window.__deco = {};
      setInterval(() => { if (!Hyper.active || !Flight.main || state !== 'playing') return; const t = clockNow() - startTime, [x, y] = Flight._safe(t); Flight._set({ gx: x, gy: y, snap: true });
        const s = Flight._s();
        for (const o of s.rocks) {
          if (!window.__seen.has(o)) { window.__seen.add(o); const k = o.hz || 'rock', into = o.deco ? window.__deco : o.k === 'L' ? window.__n : null; if (into) into[k] = (into[k] || 0) + 1; }
          if (o.k === 'L' && !o.deco && (!o.aim || o.locked) && t >= o.arrive - s.win && t <= o.arrive + (o.hold || 0) + s.win) { const d = Flight._dist(o, t, s.cx, s.cy) - o.hr - s.chr; if (d < window.__min) window.__min = d; }
        } }, 4);
      Hyper.request();
    });
    await page.waitForFunction(() => Hyper.active && Flight.on, null, { timeout: 15000 });
    await page.waitForFunction(() => !Hyper.active, null, { timeout: 45000 });
    const r = await page.evaluate(() => ({ min: window.__min, n: window.__n, deco: window.__deco, crashes: Hyper.stats.crashes, blasted: Hyper.stats.blasted, lights: Hyper.stats.rings, st: state }));
    expect(r.crashes).toBe(0);
    for (const [k, n] of Object.entries(need)) expect(r.n[k] || 0, `${k} hazards come`).toBeGreaterThanOrEqual(n);
    expect(r.min, 'never closer than a quarter of a unit (the craft is 0.32)').toBeGreaterThan(0.25);
    expect(r.blasted, 'the guns broke things by themselves').toBeGreaterThan(8);
    expect(r.lights, 'lights along the open way').toBeGreaterThan(5);
    expect(Object.keys(r.deco).sort().join(), 'scenery of its own').toBe(env === 'asteroids' ? 'rock' : env === 'nebula' ? 'puff' : 'gate,pillar');
    if (env === 'ruins') { expect(r.deco.gate).toBeGreaterThanOrEqual(3); expect(r.deco.pillar).toBeGreaterThan(10); }
    expect(r.st).toBe('playing');
    expect(real(errors)).toEqual([]);
  });
}

test('hazard shapes: a bar strikes along its whole length and not past its end; a sweep strikes when it crosses you; a pulse locks on and can be stepped off', async ({ page }) => {
  test.setTimeout(90000);
  const errors = await fly(page);
  await page.waitForFunction(() => Flight.main);
  await page.evaluate(() => Flight._quiet(true));
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms)), out = {};
    const base = (o) => Object.assign({ k: 'L', x: 0, y: 0, vx: 0, vy: 0, r: 0.26, hr: 0.2, sp: 5, deco: false, n: 1, ty: 0, th: 0, spin: 0, hp: 1, inc: 0, dead: false, passed: false, hitT: -9 }, o);
    const now = () => clockNow() - startTime;
    const go = async (x, y) => { Flight._set({ gx: x, gy: y, snap: true, shield: 3 }); await wait(1600); };      // (and out of the last hit's protection)
    const crashes = () => Hyper.stats.crashes;
    // a bar from x = -1 to +1 at y = 0
    await go(0.9, 0.1); let c = crashes(); Flight._s().rocks.push(base({ hz: 'arc', seg: [1, 0], arrive: now() + 0.05, born: now() - 1 })); await wait(300); out.barEnd = crashes() - c;
    await go(1.75, 0); c = crashes(); Flight._s().rocks.push(base({ hz: 'arc', seg: [1, 0], arrive: now() + 0.05, born: now() - 1 })); await wait(300); out.pastEnd = crashes() - c;
    await go(0, 0.75); c = crashes(); Flight._s().rocks.push(base({ hz: 'arc', seg: [1, 0], arrive: now() + 0.05, born: now() - 1 })); await wait(300); out.above = crashes() - c;
    // a wall of light over y <= 0, sweeping from x = -2 to +2 in 1 s
    await go(1, -0.3); c = crashes(); let sh = base({ hz: 'sheet', seg: [0, 1], x: -2, y: -1, vx: 4, hold: 1, sp: 0, hr: 0.16, arrive: now() + 0.1, born: now() }); Flight._s().rocks.push(sh);
    await wait(500); out.sweepBefore = crashes() - c; await wait(700); out.sweepHit = crashes() - c;
    await go(1, 0.8); c = crashes(); Flight._s().rocks.push(base({ hz: 'sheet', seg: [0, 1], x: -2, y: -1, vx: 4, hold: 1, sp: 0, hr: 0.16, arrive: now() + 0.1, born: now() })); await wait(1300); out.sweepUnder = crashes() - c;
    // a pulse: follows until 0.5 s out, then is fixed. (Flown on the side away from the safe point: a pulse
    // that would land on the safe point is pushed off it, which is the fairness rule and not this test.)
    const away = () => (Flight._safe(now() + 1)[0] > 0 ? -1 : 1);
    let w = away(); await go(w * 1.7, 0); w = away(); Flight._set({ gx: w * 1.7, gy: 0, snap: true }); c = crashes(); let p = base({ hz: 'pulse', aim: 0.5, hr: 0.36, r: 0.42, arrive: now() + 1.0, born: now() }); Flight._s().rocks.push(p);
    await wait(300); out.follows = !p.locked && Math.abs(p.x - w * 1.7) < 0.01; Flight._set({ gx: w * 1.4, gy: 0.3, snap: true }); await wait(350);
    out.locked = p.locked; out.lockedOnYou = Math.hypot(p.x - w * 1.4, p.y - 0.3) < 0.01; Flight._set({ gx: w * 0.2, gy: 0.3, snap: true }); await wait(600); out.steppedOff = crashes() - c;
    w = away(); await go(w * 1.7, 0); w = away(); Flight._set({ gx: w * 1.7, gy: 0, snap: true }); c = crashes(); Flight._s().rocks.push(base({ hz: 'pulse', aim: 0.5, hr: 0.36, r: 0.42, arrive: now() + 1.0, born: now() })); await wait(1300); out.stoodStill = crashes() - c;
    return out;
  });
  expect(r).toEqual({ barEnd: 1, pastEnd: 0, above: 0, sweepBefore: 0, sweepHit: 1, sweepUnder: 0, follows: true, locked: true, lockedOnYou: true, steppedOff: 0, stoodStill: 1 });
  expect(real(errors)).toEqual([]);
});

test('damage: a large rock costs one shield and gives 1.5 s of protection; with the shield gone, 8 energy; never the combo; debris does no harm', async ({ page }) => {
  test.setTimeout(90000);
  const errors = await fly(page);
  await page.waitForFunction(() => Flight.main);
  await page.evaluate(() => Flight._quiet(true));
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

for (const env of ['asteroids', 'nebula', 'ruins']) {
  test(`quality in the ${env}: Ultra, High, Lite and Low graphics fly the same field (same hazards, sizes, places and timing; only the scenery differs)`, async ({ page }) => {
    test.setTimeout(150000);
    const runs = [];
    for (const [sq, low] of [['ultra', false], ['high', false], ['lite', false], ['high', true]]) {
      const errors = await boot(page, { save: { level: 60, flightDone: true, settings: { spaceQuality: sq, lowGraphics: low } } });
      await page.evaluate((env) => { Flight._env(env); startGame(false); }, env);
      await page.waitForFunction(() => state === 'playing');
      const r = await page.evaluate(async () => {
        startTime = clockNow() - 100.5;
        const t = 100.5; Hyper.request(); Hyper.start(t); Flight._seed(4242);
        const s = Flight._s(), list = [], seen = new Set(); let deco = 0;
        for (let tt = t; tt < t + 30; tt += 1 / 60) { Flight.update(1 / 60, tt); for (const o of Flight._s().rocks) if (!seen.has(o)) { seen.add(o); if (o.deco && o.hz !== 'gate') deco++; else list.push([o.k, o.hz || '', Math.round(o.arrive * 100), Math.round(o.r * 100), Math.round(o.x * 100), Math.round(o.y * 100), Math.round(o.vx * 100), o.seg ? o.seg.map((v) => Math.round(v * 100)).join() : '', Math.round((o.hold || 0) * 100)]); } }
        return { q: s.q, list, deco, G: [s.G.X, s.G.Yu, s.G.Yd, s.chr] };
      });
      runs.push(r);
      expect(real(errors)).toEqual([]);
    }
    expect(runs.map((r) => r.q)).toEqual([3, 2, 1, 0]);
    expect(runs[0].list.length).toBeGreaterThan(40);
    for (const r of runs.slice(1)) { expect(r.list).toEqual(runs[0].list); expect(r.G).toEqual(runs[0].G); }
    expect(runs[0].deco, 'more scenery at higher quality').toBeGreaterThan(runs[3].deco * (env === 'ruins' ? 1.5 : 3));
  });
}

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
