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
  resyncs: typeof _t6ResyncCount === 'number' ? _t6ResyncCount : null,
  from: typeof pauseInfo !== 'undefined' && pauseInfo ? pauseInfo.from : null }));
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
      if (state !== 'paused' || performance.now() - t0 > 8000) return resolve({ digits: out, ms: performance.now() - t0, state, ac: audioCtx ? audioCtx.currentTime : null });
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
  // Baseline is p0 (pause applied), not `before`: energy drains every frame during play, so the
  // ms between the `before` snapshot and the click registering legitimately move it. While
  // paused it must not move at all.
  expect(p1.energy, 'no energy drain while paused (frozen exactly)').toBe(p0.energy);
  expect(cd.digits.slice(0, 3), '3-2-1 countdown').toEqual(['3', '2', '1']);
  // The bot can legitimately trigger a level-up in the ms before the click lands; Resume must
  // return to exactly the state the pause interrupted (normally 'playing').
  expect(['playing', 'levelup', 'bossIntro', 'bossBattle', 'bossDefeat'], 'paused from an in-run state').toContain(p0.from);
  expect(cd.state, 'resumes into the state it paused from').toBe(p0.from);
  // Baseline is p0 (the moment the pause took effect), not `before`: the bot can legitimately
  // land a hit in the ms between the `before` snapshot and the click registering. Anything that
  // happened in that window must be a gain only; from p0 on, state must be frozen exactly.
  const st = (s) => ({ score: s.score, combo: s.combo, stage: s.stage, misses: s.misses });
  expect(p0.misses, 'no misses between snapshot and pause').toBe(before.misses);
  expect(p0.stage, 'stage unchanged by pausing').toBe(before.stage);
  expect(p0.score, 'pausing never removes score').toBeGreaterThanOrEqual(before.score);
  expect(st(p1), 'state frozen while paused').toEqual(st(p0));
  expect(st(r0), 'score and state preserved through resume').toEqual(st(p0));
  // The restore is scheduled at audioCtx.currentTime; AudioParam.value only reflects it once the
  // audio thread has rendered past that point. Read it when the AUDIO clock is 50 ms past resume:
  // strict in audio time, and immune to the test machine's own scheduling delays.
  const restored = await page.evaluate((acResume) => new Promise((resolve) => {
    const t0 = performance.now();
    (function wait() {
      if (audioCtx.currentTime >= acResume + 0.05) return resolve({ gain: musicGain.gain.value, audioMs: (audioCtx.currentTime - acResume) * 1000 });
      if (performance.now() - t0 > 5000) return resolve({ gain: musicGain.gain.value, audioMs: null });
      requestAnimationFrame(wait);
    })();
  }), cd.ac);
  expect(restored.audioMs, 'audio clock advanced after resume').not.toBeNull();
  expect(restored.gain, 'music restored within 50 ms of audio time after resume').toBeGreaterThan(0.01);
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

// ---- iOS device reports (Dennel, 2026-11-01) ----
// iOS Safari can keep the AudioContext reporting 'running' while its clock has stopped:
// during Siri, and after the screen is locked and woken. These tests fake that by
// overriding audioCtx.currentTime on the instance (the engine's own clock is untouched).
async function freezeAudioClock(page) {
  await page.evaluate(() => {
    const proto = Object.getPrototypeOf(audioCtx);
    const real = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'currentTime').get;
    window.__frozenAt = real.call(audioCtx);
    window.__realCT = () => real.call(audioCtx);
    Object.defineProperty(audioCtx, 'currentTime', { configurable: true, get: () => window.__frozenAt });
  });
}
async function thawAudioClock(page, { restartAt = null } = {}) {
  await page.evaluate((restart) => {
    // continue from the frozen value, or (iOS after a lock) restart the timeline near `restart`
    const from = restart === null ? window.__frozenAt : restart;
    const offset = window.__realCT() - from;
    Object.defineProperty(audioCtx, 'currentTime', { configurable: true, get: () => window.__realCT() - offset });
  }, restartAt);
}

test('T6 iOS Siri: audio clock stops while the context still says running → auto-pause, no misses', async ({ page }) => {
  const errors = await boot(page);
  await installProbes(page);
  await startRun(page);
  await startBot(page);
  await page.waitForTimeout(4000);
  const before = await snap(page);
  await freezeAudioClock(page);            // Siri: state stays 'running', clock stops, page stays visible
  await page.waitForTimeout(2500);
  const during = await snap(page);
  await thawAudioClock(page);
  const cd = await resumeAndCount(page);
  await page.waitForTimeout(7000);
  const grid = await gridAfter(page, during.nq);
  writeResult('phase2-ios-siri', { before, during, countdown: cd, gridAfterResumeMs: grid, errors });
  expect(errors).toEqual([]);
  expect(during.state, 'paused during Siri').toBe('paused');
  expect(during.misses - before.misses).toBe(0);
  expect(cd.state).toBe('playing');
  expect(grid.length, 'rings spawn after resume').toBeGreaterThanOrEqual(3);
  expect(grid.filter((e) => Math.abs(e) > GRID_TOL_MS).length).toBe(0);
});

test('T6 iOS screen lock: after waking, the clock is stuck until Resume kicks it → countdown waits, then rings spawn on the grid', async ({ page }) => {
  const errors = await boot(page);
  await installProbes(page);
  await startRun(page);
  await startBot(page);
  await page.waitForTimeout(4000);
  await hideTab(page);                     // screen off
  await page.waitForTimeout(2000);
  await freezeAudioClock(page);            // woken context: says running, clock stuck
  await showTab(page);
  await page.waitForTimeout(1000);
  const back = await snap(page);
  // The stuck clock thaws only when Resume kicks the audio (silent buffer / suspend+resume)
  await page.evaluate(() => {
    const realResume = audioCtx.resume.bind(audioCtx), realSuspend = audioCtx.suspend.bind(audioCtx);
    window.__kicked = 0;
    audioCtx.suspend = () => { window.__kicked++; return realSuspend(); };
    audioCtx.resume = () => realResume();
    const realCreate = audioCtx.createBufferSource.bind(audioCtx);
    audioCtx.createBufferSource = () => { window.__kicked++; return realCreate(); };
  });
  const thaw = setTimeout(() => {}, 0);
  const watcher = page.evaluate(() => new Promise((res) => { (function w() { if (window.__kicked > 0) return res(true); setTimeout(w, 20); })(); }));
  const clicked = page.click('#pauseResumeBtn', { timeout: 5000 });
  await watcher; await thawAudioClock(page, { restartAt: 0.2 });   // iOS may also restart the timeline near 0
  await clicked; clearTimeout(thaw);
  await page.waitForFunction(() => state !== 'paused', null, { timeout: 10000 });
  const r0 = await snap(page);
  await page.waitForTimeout(7000);
  const grid = await gridAfter(page, back.nq);
  const end = await snap(page);
  writeResult('phase2-ios-lock', { back, r0, end, gridAfterResumeMs: grid, errors });
  expect(errors).toEqual([]);
  expect(back.state).toBe('paused');
  expect(r0.state).toBe('playing');
  expect(grid.length, 'rings spawn after waking + resume').toBeGreaterThanOrEqual(3);
  expect(grid.filter((e) => Math.abs(e) > GRID_TOL_MS).length).toBe(0);
  expect(end.steps - r0.steps, 'music plays after resume').toBeGreaterThan(20);
});
