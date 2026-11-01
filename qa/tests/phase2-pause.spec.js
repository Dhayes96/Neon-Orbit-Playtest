// Phase 2 · T6 (RV-03 and the pause/resume design Dennel approved on 2026-11-01).
// Design under test: upper-right pause button; auto-pause on tab/app switch, focus loss
// and audio interruption; Resume runs a 3-2-1 countdown, then audio and ring scheduling
// restart together. In-flight rings are cleared with no penalty, and score/state are preserved.
// Acceptance (Jarvis's T6 scope + ChatGPT review): 0 misses during an interruption,
// ≤ 2 ms grid error after resume, exactly 1 resync per interruption, score and state
// preserved. These tests are expected to FAIL on main (no pause controller yet).
const { test, expect } = require('@playwright/test');
const { boot, installProbes, startBot, writeResult } = require('./harness');

const GRID_TOL_MS = 2;
test.describe.configure({ timeout: 90_000 });

async function startRun(page) {
  await page.click('#startBtn');
  await page.waitForFunction(() => state === 'playing');
  await page.waitForFunction(() => audioCtx && audioCtx.state === 'running' && music.on, null, { timeout: 5000 });
}
const snap = (page) => page.evaluate(() => ({ state, score, combo, energy: +energy.toFixed(3), stage, misses: runStats.misses,
  hits: runStats.hits, steps: __qa.steps.length, nq: __qa.notes.length, notes: notes.length, now: clockNow(),
  musicGain: musicGain ? musicGain.gain.value : null,
  pauses: typeof _t6PauseCount === 'number' ? _t6PauseCount : null,
  resyncs: typeof _t6ResyncCount === 'number' ? _t6ResyncCount : null }));
async function hideTab(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('pagehide'));
  });
}
async function showTab(page) {
  await page.evaluate(() => {
    delete document.hidden; delete document.visibilityState;
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('pageshow'));
  });
}
// Click Resume, record the countdown digits shown, and wait until play resumes.
async function resumeAndCount(page) {
  await page.click('#pauseResumeBtn', { timeout: 5000 });
  const seen = await page.evaluate(() => new Promise((resolve) => {
    const out = []; const t0 = performance.now();
    (function poll() {
      const el = document.getElementById('pauseCount');
      const txt = el && el.offsetParent !== null ? el.textContent.trim() : '';
      if (txt && out[out.length - 1] !== txt) out.push(txt);
      if (state !== 'paused' || performance.now() - t0 > 8000) return resolve({ digits: out, ms: performance.now() - t0, state });
      requestAnimationFrame(poll);
    })();
  }));
  return seen;
}
// Rings spawned after probe index `fromIdx` (taken while paused, when nothing spawns)
// vs the audio steps actually scheduled. Indexing avoids time math across the
// startTime shift that resume applies.
async function gridAfter(page, fromIdx) {
  return page.evaluate((since) => {
    const steps = __qa.steps; const lastW = steps.length ? steps[steps.length - 1].when : 0;
    const out = [];
    for (const n of __qa.notes.slice(since)) {
      if (n.audio == null || n.cleared || n.audio > lastW - 0.05) continue;
      let bd = Infinity, e = 0;
      for (const s of steps) { const d = Math.abs(n.audio - s.w); if (d < bd) { bd = d; e = (n.audio - s.w) * 1000; } }
      out.push(+e.toFixed(2));
    }
    return out;
  }, fromIdx);
}

test('T6 pause button: upper-right, freezes the run with no penalty, silences music; Resume counts 3-2-1 and play resumes on the grid', async ({ page }) => {
  const errors = await boot(page);
  await installProbes(page);
  await startRun(page);
  await startBot(page);
  await page.waitForTimeout(4000);
  const btn = page.locator('#pauseBtn');
  await expect(btn).toBeVisible();
  const box = await btn.boundingBox(); const vp = page.viewportSize();
  const before = await snap(page);
  await btn.click({ timeout: 5000 });
  await page.waitForTimeout(250);
  const p0 = await snap(page);
  await page.waitForTimeout(2000);
  const p1 = await snap(page);
  const cd = await resumeAndCount(page);
  const r0 = await snap(page);
  await page.waitForTimeout(7000);
  const grid = await gridAfter(page, p1.nq);   // nothing spawns while paused, so everything after p1 is post-resume
  const end = await snap(page);
  const res = { box, vp, before, p0, p1, countdown: cd, r0, end, gridAfterResumeMs: grid, errors };
  writeResult('phase2-pause-button', res);
  expect(errors).toEqual([]);
  expect(box.x + box.width / 2, 'button on the right').toBeGreaterThan(vp.width * 0.6);
  expect(box.y + box.height / 2, 'button near the top').toBeLessThan(vp.height * 0.25);
  expect(p0.state).toBe('paused');
  expect(p0.notes, 'in-flight rings cleared on pause').toBe(0);
  expect(p1.steps - p0.steps, 'no music steps scheduled while paused').toBe(0);
  expect(p1.musicGain, 'music silenced while paused').toBeLessThan(0.01);
  expect(p1.misses - before.misses, 'no misses from pausing').toBe(0);
  expect(p1.energy, 'no energy drain while paused').toBeGreaterThanOrEqual(before.energy - 0.5);
  expect(cd.digits.slice(0, 3), '3-2-1 countdown').toEqual(['3', '2', '1']);
  expect(cd.state).toBe('playing');
  expect({ score: r0.score, combo: r0.combo, stage: r0.stage, misses: r0.misses },
    'score and state preserved').toEqual({ score: before.score, combo: before.combo, stage: before.stage, misses: before.misses });
  expect(r0.musicGain, 'music restored on resume').toBeGreaterThan(0.01);
  expect(r0.resyncs - before.resyncs, 'exactly one resync').toBe(1);
  expect(grid.length, 'rings scheduled after resume').toBeGreaterThanOrEqual(3);
  expect(grid.filter((e) => Math.abs(e) > GRID_TOL_MS).length, 'rings off the grid after resume').toBe(0);
});

test('T6 tab switch: auto-pauses, stays paused on return (no misses); one Resume gives exactly one resync and an on-grid run', async ({ page }) => {
  const errors = await boot(page);
  await installProbes(page);
  await startRun(page);
  await startBot(page);
  await page.waitForFunction(() => state === 'playing' && notes.filter((n) => !n.hit && !n.missed).length >= 2 && (clockNow() - startTime) > 4, null, { timeout: 30000 });
  const before = await snap(page);
  await hideTab(page);                 // visibilitychange + blur + pagehide together
  await page.waitForTimeout(3000);
  const hidden = await page.evaluate(() => ({ state, ac: audioCtx.state }));
  await showTab(page);                 // visibilitychange + focus + pageshow together
  await page.waitForTimeout(1500);
  const back = await snap(page);
  const cd = await resumeAndCount(page);
  const r0 = await snap(page);
  await page.waitForTimeout(7000);
  const grid = await gridAfter(page, back.nq);
  const res = { before, hidden, back, countdown: cd, r0, gridAfterResumeMs: grid, errors };
  writeResult('phase2-tab-switch', res);
  expect(errors).toEqual([]);
  expect(hidden.state).toBe('paused');
  expect(back.state, 'still paused after returning').toBe('paused');
  expect(back.misses - before.misses, 'no misses from the tab switch').toBe(0);
  expect(back.pauses - before.pauses, 'one pause despite 3 hide events').toBe(1);
  expect(r0.resyncs - before.resyncs, 'one resync despite 3 return events').toBe(1);
  expect(r0.score, 'score preserved across the pause').toBe(back.score);
  expect(grid.length).toBeGreaterThanOrEqual(3);
  expect(grid.filter((e) => Math.abs(e) > GRID_TOL_MS).length, 'rings off the grid after resume').toBe(0);
});

test('T6 focus loss: a window blur alone auto-pauses the run (no misses)', async ({ page }) => {
  const errors = await boot(page);
  await installProbes(page);
  await startRun(page);
  await startBot(page);
  await page.waitForTimeout(4000);
  const before = await snap(page);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForTimeout(2000);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(500);
  const after = await snap(page);
  writeResult('phase2-blur', { before, after, errors });
  expect(errors).toEqual([]);
  expect(after.state).toBe('paused');
  expect(after.misses - before.misses).toBe(0);
});

test('T6 audio interruption while visible (OS holds the context): auto-pause, no energy loss; Resume restarts audio on the grid', async ({ page }) => {
  const errors = await boot(page);
  await installProbes(page);
  await startRun(page);
  await startBot(page);
  await page.waitForTimeout(4000);
  const before = await snap(page);
  // Simulate an iOS-style interruption: the context is suspended and refuses to resume for 3 s.
  await page.evaluate(() => {
    window.__realResume = audioCtx.resume.bind(audioCtx);
    audioCtx.resume = () => Promise.resolve();
    audioCtx.suspend();
  });
  await page.waitForTimeout(3000);
  const during = await snap(page);
  await page.evaluate(() => { audioCtx.resume = window.__realResume; });
  const cd = await resumeAndCount(page);
  const r0 = await snap(page);
  await page.waitForTimeout(7000);
  const grid = await gridAfter(page, during.nq);
  const ac = await page.evaluate(() => audioCtx.state);
  writeResult('phase2-audio-interruption', { before, during, countdown: cd, r0, ac, gridAfterResumeMs: grid, errors });
  expect(errors).toEqual([]);
  expect(during.state).toBe('paused');
  expect(during.misses - before.misses, 'no misses during the interruption').toBe(0);
  expect(during.energy, 'no energy lost during the interruption').toBeGreaterThanOrEqual(before.energy - 0.5);
  expect(ac).toBe('running');
  expect(cd.state).toBe('playing');
  expect(r0.resyncs - before.resyncs).toBe(1);
  expect(grid.length).toBeGreaterThanOrEqual(3);
  expect(grid.filter((e) => Math.abs(e) > GRID_TOL_MS).length, 'rings off the grid after resume').toBe(0);
});

test('T6a 700 ms main-thread stall: the music re-anchors by whole steps, so in-flight rings stay on the audio grid', async ({ page }) => {
  const errors = await boot(page);
  await installProbes(page);
  await startRun(page);
  await startBot(page);
  await page.waitForFunction(() => state === 'playing' && notes.filter((n) => !n.hit && !n.missed && n.hitTime > clockNow() - startTime + 1.0).length >= 1 && (clockNow() - startTime) > 4, null, { timeout: 30000 });
  // Stall the main thread (timers and rAF can't run), then look at rings still in flight.
  const inFlight = await page.evaluate(() => {
    const t0 = performance.now(); while (performance.now() - t0 < 700) { /* stall */ }
    const now = clockNow() - startTime;
    return notes.filter((n) => !n.hit && !n.missed && n.hitTime > now + 0.15).map((n) => ({ audio: Conductor.gameToAudio(n.hitTime) }));
  });
  await page.waitForTimeout(4000);
  const steps = await page.evaluate(() => __qa.steps);
  const errs = inFlight.map((n) => { let bd = Infinity, e = 0; for (const s of steps) { const d = Math.abs(n.audio - s.w); if (d < bd) { bd = d; e = (n.audio - s.w) * 1000; } } return +e.toFixed(2); });
  writeResult('phase2-stall', { inFlight: inFlight.length, errMs: errs, errors });
  expect(errors).toEqual([]);
  expect(inFlight.length, 'rings in flight after the stall').toBeGreaterThanOrEqual(1);
  expect(errs.filter((e) => Math.abs(e) > GRID_TOL_MS).length, 'in-flight rings off the grid after a stall').toBe(0);
});
