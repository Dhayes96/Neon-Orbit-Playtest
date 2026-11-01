// Phase 2 · T6 acceptance soak: RV_SOAK_MIN minutes (default 10) of play with a random
// interruption about every 40 s: pause button, tab switch, focus loss, audio interruption,
// or a 700 ms main-thread stall. After each one the run is resumed the way a player would
// (tap Resume, wait for the 3-2-1). Acceptance: p99 ring-vs-music grid error ≤ 2 ms over
// every live ring, 0 misses caused by interruptions, exactly 1 resync per pause.
// Run: RV_SOAK_MIN=10 npx playwright test tests/phase2-soak.spec.js --project=desktop-chrome
const { test, expect } = require('@playwright/test');
const { boot, installProbes, startBot, pct, writeResult } = require('./harness');

const MIN = Number(process.env.RV_SOAK_MIN || 10);
const KINDS = ['button', 'tab', 'blur', 'audio', 'stall'];

test(`T6 soak: ${MIN} min with random interruptions — grid p99 ≤ 2 ms, 0 interruption misses, 1 resync per pause`, async ({ page }) => {
  test.setTimeout((MIN * 60 + 180) * 1000);
  const errors = await boot(page, { seed: 4321 });
  await installProbes(page);
  await page.click('#startBtn');
  await page.waitForFunction(() => state === 'playing' && audioCtx.state === 'running');
  await startBot(page);
  // keep the run alive across game-overs (new run, same probes)
  await page.evaluate(() => { window.__restarts = 0; (function f() { if (state === 'gameover') { window.__restarts++; startGame(false); } requestAnimationFrame(f); })(); });
  const log = [];
  let rnd = 7;
  const next = () => (rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648;
  const t0 = Date.now();
  while (Date.now() - t0 < MIN * 60_000 - 45_000) {
    await page.waitForTimeout(30_000 + Math.floor(next() * 20_000));
    const ok = await page.evaluate(() => state === 'playing' || state === 'bossBattle');
    if (!ok) continue;
    const kind = KINDS[Math.floor(next() * KINDS.length)];
    const before = await page.evaluate(() => ({ misses: runStats.misses, pauses: _t6PauseCount, resyncs: _t6ResyncCount, energy: energy }));
    if (kind === 'button') await page.click('#pauseBtn');
    if (kind === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    if (kind === 'tab') await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('blur')); });
    if (kind === 'audio') await page.evaluate(() => { window.__rr = audioCtx.resume.bind(audioCtx); audioCtx.resume = () => Promise.resolve(); audioCtx.suspend(); });
    if (kind === 'stall') await page.evaluate(() => { const s = performance.now(); while (performance.now() - s < 700) { /* stall */ } });
    await page.waitForTimeout(1500 + Math.floor(next() * 1500));
    if (kind === 'tab') await page.evaluate(() => { delete document.hidden; delete document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('pageshow')); });
    if (kind === 'audio') await page.evaluate(() => { audioCtx.resume = window.__rr; });
    if (kind === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const mid = await page.evaluate(() => ({ state, misses: runStats.misses, energy: energy }));
    if (mid.state === 'paused') {
      await page.click('#pauseResumeBtn');
      await page.waitForFunction(() => state !== 'paused', null, { timeout: 10_000 });
    }
    const after = await page.evaluate(() => ({ state, pauses: _t6PauseCount, resyncs: _t6ResyncCount }));
    log.push({ kind, pausedState: mid.state, missesDuring: mid.misses - before.misses, energyDrop: +(before.energy - mid.energy).toFixed(2),
      pauses: after.pauses - before.pauses, resyncs: after.resyncs - before.resyncs, resumedTo: after.state });
  }
  await page.waitForTimeout(5000);
  const r = await page.evaluate(() => {
    const steps = __qa.steps; const lastW = steps.length ? steps[steps.length - 1].when : 0;
    const errs = [];
    for (const n of __qa.notes) {
      if (n.audio == null || n.cleared || n.audio > lastW - 0.05) continue;
      if (n.audio < steps[0].w) continue;
      // binary search the nearest scheduled step
      let lo = 0, hi = steps.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (steps[m].w < n.audio) lo = m; else hi = m; }
      const e = Math.abs(n.audio - steps[lo].w) < Math.abs(n.audio - steps[hi].w) ? n.audio - steps[lo].w : n.audio - steps[hi].w;
      errs.push(e * 1000);
    }
    return { errs, restarts: window.__restarts, rings: __qa.notes.length, taps: __qa.taps.reduce((m, t) => (m[t.res] = (m[t.res] || 0) + 1, m), {}) };
  });
  // Rings a pause clears are marked `cleared` by the harness (pauseGame is wrapped), so
  // every remaining ring was really shown and played: no filtering here.
  const abs = r.errs.map(Math.abs);
  const shown = abs;
  const res = { minutes: MIN, interruptions: log.length, byKind: log.reduce((m, x) => (m[x.kind] = (m[x.kind] || 0) + 1, m), {}), log,
    ringsAnalysed: shown.length, gridMs: { p50: pct(shown, 50), p99: pct(shown, 99), max: Math.max(...shown) },
    over2ms: shown.filter((e) => e > 2).length, restarts: r.restarts, taps: r.taps, errors };
  writeResult('phase2-soak', res);
  console.log(JSON.stringify({ interruptions: res.interruptions, byKind: res.byKind, rings: res.ringsAnalysed, gridMs: res.gridMs, over2ms: res.over2ms, taps: res.taps }));
  expect(errors).toEqual([]);
  expect(res.interruptions).toBeGreaterThanOrEqual(Math.max(1, Math.floor(MIN * 60 / 50) - 1));
  expect(log.filter((x) => x.kind !== 'stall' && x.pausedState !== 'paused'), 'every interruption except a stall pauses').toEqual([]);
  expect(log.filter((x) => x.missesDuring > 0 && x.kind !== 'stall'), 'no misses during an interruption').toEqual([]);
  expect(log.filter((x) => x.kind !== 'stall' && (x.pauses !== 1 || x.resyncs !== 1)), 'exactly 1 pause and 1 resync each').toEqual([]);
  expect(res.gridMs.p99, 'p99 grid error').toBeLessThanOrEqual(2);
});
