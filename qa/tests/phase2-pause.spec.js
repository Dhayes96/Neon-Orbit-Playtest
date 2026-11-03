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
// State captured INSIDE the game at the exact moment a pause takes effect (and, via
// __snapNow, at the exact moment a simulated interruption starts). A snapshot taken by the
// test a few ms earlier races the bot: under main-thread stalls (software-rendered WebKit
// freezes 0.3-0.85 s on CI) it can legitimately land or miss a ring in that gap.
async function capturePauses(page) {
  await page.evaluate(() => {
    window.__snapNow = () => ({ state, score, combo, stage, misses: runStats.misses, energy: +energy.toFixed(3), ac: audioCtx ? audioCtx.currentTime : null });
    window.__pauses = [];
    const orig = window.pauseGame;
    window.pauseGame = function (reason) {
      const pre = inRunState() ? window.__snapNow() : null;
      const did = orig.apply(this, arguments);
      if (pre && state === 'paused') window.__pauses.push({ ...pre, reason });
      return did;
    };
  });
}
// Record every automation call the game makes on the music bus gain: what it scheduled, for when,
// and the audio clock at the call. This is what the game controls, identically on every engine.
// (Reading AudioParam.value is engine-dependent: under CPU starvation WebKit's currentTime keeps
// advancing while its render thread lags, so .value can trail the schedule by a lot.)
async function recordMusicAutomation(page) {
  await page.evaluate(() => {
    window.__gainLog = [];
    const g = musicGain.gain;
    for (const fn of ['setValueAtTime', 'setTargetAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'cancelScheduledValues']) {
      const orig = g[fn].bind(g);
      g[fn] = function (...a) { window.__gainLog.push({ fn, v: fn === 'cancelScheduledValues' ? null : a[0], t: fn === 'cancelScheduledValues' ? a[0] : a[1], ac: audioCtx.currentTime, state }); return orig(...a); };
    }
  });
}
const pollGain = (page, cmp, limit, ms) => expect.poll(() => page.evaluate(() => musicGain.gain.value), { timeout: ms, intervals: [20] })[cmp](limit);
const prePause = (page, i = 0) => page.evaluate((k) => window.__pauses[k] || null, i);
const st = (s) => ({ score: s.score, combo: s.combo, stage: s.stage, misses: s.misses });

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
// Grid error (ms) of a ring's audio time against the music's beat grid. The grid is defined
// by the steps the sequencer actually scheduled: the nearest scheduled step s, plus k whole
// steps (same BPM, swing applied to the slot exactly as the sequencer does). k != 0 means the
// ring's beat was DROPPED by the scheduler: by design it never schedules into the past, so a
// main-thread freeze longer than its 140 ms lookahead skips a 16th (see musicTick / T6a).
// Such a ring is still exactly on the beat; it is counted separately (`dropped`), not as off-grid.
function gridError(audio, bpm, steps) {
  let s = null, bd = Infinity;
  for (const x of steps) { const d = Math.abs(audio - x.w); if (d < bd) { bd = d; s = x; } }
  if (!s) return { e: Infinity, k: 0 };
  const k = Math.round((audio - s.when) / s.stepDur);
  // (BPM may ramp slightly between spawn and scheduling; an invalid extrapolation can only
  // make the residual larger, i.e. fail, so the 2 ms bound below stays the guard.)
  if (k === 0 || Math.abs(k) > 4) return { e: (audio - s.w) * 1000, k: 0 };
  const slot = (((s.step + k) % 4) + 4) % 4;
  const expected = s.when + k * s.stepDur + (s.sw && slot === 2 ? s.stepDur * s.sw : 0);
  return { e: (audio - expected) * 1000, k };
}
// Rings spawned after probe index `fromIdx` (taken while paused, when nothing spawns).
// Indexing avoids time math across the startTime shift that resume applies.
async function gridAfter(page, fromIdx) {
  const { notes, steps } = await page.evaluate((since) => ({ notes: __qa.notes.slice(since), steps: __qa.steps }), fromIdx);
  const lastW = steps.length ? steps[steps.length - 1].when : 0;
  const out = []; out.dropped = 0;
  for (const n of notes) {
    if (n.audio == null || n.cleared || n.audio > lastW - 0.05) continue;
    const g = gridError(n.audio, n.bpm, steps);
    if (g.k) out.dropped++;
    out.push(+g.e.toFixed(2));
  }
  return out;
}

test('T6 pause button: upper-right, freezes the run with no penalty, silences music; Resume counts 3-2-1 and play resumes on the grid', async ({ page }) => {
  const errors = await boot(page);
  await installProbes(page);
  await capturePauses(page);
  await startRun(page);
  await recordMusicAutomation(page);
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
  const pre = await prePause(page);            // state at the exact moment the pause took effect
  const gainPaused = await page.evaluate(() => musicGain.gain.value);   // 2 s into the pause
  const cd = await resumeAndCount(page);
  const r0 = await snap(page);
  const gainLog = await page.evaluate(() => window.__gainLog);
  await page.waitForTimeout(7000);
  const grid = await gridAfter(page, p1.nq);   // nothing spawns while paused, so everything after p1 is post-resume
  const end = await snap(page);
  const res = { box, vp, before, pre, p0, p1, gainPaused, gainLog, countdown: cd, r0, end, gridAfterResumeMs: grid, ringsOnDroppedSteps: grid.dropped, errors };
  writeResult('phase2-pause-button', res);
  expect(errors).toEqual([]);
  expect(box.x + box.width / 2, 'button on the right').toBeGreaterThan(vp.width * 0.6);
  expect(box.y + box.height / 2, 'button near the top').toBeLessThan(vp.height * 0.25);
  expect(p0.state).toBe('paused');
  expect(p0.notes, 'in-flight rings cleared on pause').toBe(0);
  expect(p1.steps - p0.steps, 'no music steps scheduled while paused').toBe(0);
  // Music bus, as scheduled by the game (exact, engine-independent):
  //  - at the pause: a fade toward silence (<= 0.001) starting immediately (time constant <= 30 ms);
  //  - while paused: nothing raises the gain;
  //  - at resume: the gain is set back up (> 0.01) immediately, before play restarts.
  const pauseIdx = gainLog.findIndex((c) => c.fn === 'setTargetAtTime' && c.v <= 0.001 && c.state === 'paused');
  expect(pauseIdx, 'pause schedules the music fade-out').toBeGreaterThanOrEqual(0);
  const fade = gainLog[pauseIdx];
  expect(fade.t - fade.ac, 'fade-out starts immediately').toBeLessThanOrEqual(0.005);
  const resumeIdx = gainLog.findIndex((c, i) => i > pauseIdx && c.fn === 'setValueAtTime' && c.v > 0.01);
  expect(resumeIdx, 'resume schedules the music back up').toBeGreaterThan(pauseIdx);
  const up = gainLog[resumeIdx];
  expect(up.t - up.ac, 'music restore is immediate').toBeLessThanOrEqual(0.005);
  expect(up.ac, 'restored no later than play restarts').toBeLessThanOrEqual(cd.ac + 1e-6);
  expect(up.state, 'music comes back only when play restarts, not during the pause/countdown').not.toBe('paused');
  expect(gainLog.slice(pauseIdx + 1, resumeIdx).filter((c) => c.v != null && c.v > 0.01), 'nothing raises the music while paused').toEqual([]);
  // ...and the engine actually applies it (eventually; timing is asserted on the schedule above).
  expect(gainPaused, 'engine reports music silenced 2 s into the pause').toBeLessThan(0.01);
  // Baseline is `pre`, captured inside the game at the exact moment the pause took effect.
  // (A test-side snapshot taken earlier races the bot, which can land or miss a ring in the gap,
  // most of all during WebKit's main-thread freezes.) From that moment, nothing may change:
  // no misses, no score/combo/stage change, no energy drain, through the pause and the resume.
  expect(pre, 'pause captured in-game').not.toBeNull();
  expect(pre.reason).toBe('button');
  expect(st(p0), 'pausing itself changes nothing').toEqual(st(pre));
  expect(p0.energy, 'no energy change from pausing').toBe(pre.energy);
  expect(st(p1), 'state frozen while paused').toEqual(st(pre));
  expect(p1.energy, 'no energy drain while paused (frozen exactly)').toBe(pre.energy);
  expect(cd.digits.slice(0, 3), '3-2-1 countdown').toEqual(['3', '2', '1']);
  // Resume must return to exactly the state the pause interrupted (normally 'playing'; a bot hit
  // just before the click can legitimately have started a level-up).
  expect(['playing', 'levelup', 'bossIntro', 'bossBattle', 'bossDefeat'], 'paused from an in-run state').toContain(pre.state);
  expect(p0.from).toBe(pre.state);
  expect(cd.state, 'resumes into the state it paused from').toBe(pre.state);
  expect(st(r0), 'score and state preserved through resume').toEqual(st(pre));
  await pollGain(page, 'toBeGreaterThan', 0.01, 2000);   // engine reports the music back up
  expect(r0.resyncs - before.resyncs, 'exactly one resync').toBe(1);
  expect(grid.length, 'rings scheduled after resume').toBeGreaterThanOrEqual(3);
  expect(grid.filter((e) => Math.abs(e) > GRID_TOL_MS).length, 'rings off the grid after resume').toBe(0);
});

test('T6 tab switch: auto-pauses, stays paused on return (no misses); one Resume gives exactly one resync and an on-grid run', async ({ page }) => {
  const errors = await boot(page);
  await installProbes(page);
  await capturePauses(page);
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
  const pre = await prePause(page);
  const cd = await resumeAndCount(page);
  const r0 = await snap(page);
  await page.waitForTimeout(7000);
  const grid = await gridAfter(page, back.nq);
  const res = { before, pre, hidden, back, countdown: cd, r0, gridAfterResumeMs: grid, ringsOnDroppedSteps: grid.dropped, errors };
  writeResult('phase2-tab-switch', res);
  expect(errors).toEqual([]);
  expect(hidden.state).toBe('paused');
  expect(back.state, 'still paused after returning').toBe('paused');
  // Baseline: game state at the exact moment the pause took effect (see capturePauses).
  expect(pre, 'pause captured in-game').not.toBeNull();
  expect(st(back), 'no misses or state change from the tab switch').toEqual(st(pre));
  expect(back.energy, 'no energy drain while hidden').toBe(pre.energy);
  expect(back.pauses - before.pauses, 'one pause despite 3 hide events').toBe(1);
  expect(r0.resyncs - before.resyncs, 'one resync despite 3 return events').toBe(1);
  expect(r0.score, 'score preserved across the pause').toBe(back.score);
  expect(grid.length).toBeGreaterThanOrEqual(3);
  expect(grid.filter((e) => Math.abs(e) > GRID_TOL_MS).length, 'rings off the grid after resume').toBe(0);
});

test('T6 focus loss: a window blur alone auto-pauses the run (no misses)', async ({ page }) => {
  const errors = await boot(page);
  await installProbes(page);
  await capturePauses(page);
  await startRun(page);
  await startBot(page);
  await page.waitForTimeout(4000);
  const before = await snap(page);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForTimeout(2000);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(500);
  const after = await snap(page);
  const pre = await prePause(page);
  writeResult('phase2-blur', { before, pre, after, errors });
  expect(errors).toEqual([]);
  expect(after.state).toBe('paused');
  expect(pre, 'pause captured in-game').not.toBeNull();
  expect(st(after), 'no misses or state change from the blur').toEqual(st(pre));
});

test('T6 audio interruption while visible (OS holds the context): auto-pause, no energy loss; Resume restarts audio on the grid', async ({ page }) => {
  const errors = await boot(page);
  await installProbes(page);
  await capturePauses(page);
  await startRun(page);
  await startBot(page);
  await page.waitForTimeout(4000);
  const before = await snap(page);
  // Simulate an iOS-style interruption: the context is suspended and refuses to resume for 3 s.
  const atSuspend = await page.evaluate(() => {
    const at = window.__snapNow();      // state at the exact moment the interruption starts
    window.__realResume = audioCtx.resume.bind(audioCtx);
    audioCtx.resume = () => Promise.resolve();
    audioCtx.suspend();
    return at;
  });
  await page.waitForTimeout(3000);
  const during = await snap(page);
  await page.evaluate(() => { audioCtx.resume = window.__realResume; });
  const cd = await resumeAndCount(page);
  const r0 = await snap(page);
  await page.waitForTimeout(7000);
  const grid = await gridAfter(page, during.nq);
  const ac = await page.evaluate(() => audioCtx.state);
  writeResult('phase2-audio-interruption', { before, atSuspend, during, countdown: cd, r0, ac, gridAfterResumeMs: grid, ringsOnDroppedSteps: grid.dropped, errors });
  expect(errors).toEqual([]);
  expect(during.state).toBe('paused');
  // Baseline: state at the instant the interruption starts (taken in the same task that
  // suspends the context), so bot activity before it can't leak in. The 0.5 energy tolerance
  // covers the real gap between the context suspending and the game detecting it.
  expect(during.misses - atSuspend.misses, 'no misses during the interruption').toBe(0);
  expect(during.energy, 'no energy lost during the interruption').toBeGreaterThanOrEqual(atSuspend.energy - 0.5);
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
    return notes.filter((n) => !n.hit && !n.missed && n.hitTime > now + 0.15).map((n) => ({ audio: Conductor.gameToAudio(n.hitTime), bpm }));
  });
  await page.waitForTimeout(4000);
  const steps = await page.evaluate(() => __qa.steps);
  const g = inFlight.map((n) => gridError(n.audio, n.bpm, steps));
  const errs = g.map((x) => +x.e.toFixed(2));
  writeResult('phase2-stall', { inFlight: inFlight.length, errMs: errs, ringsOnDroppedSteps: g.filter((x) => x.k).length, errors });
  expect(errors).toEqual([]);
  expect(inFlight.length, 'rings in flight after the stall').toBeGreaterThanOrEqual(1);
  expect(errs.filter((e) => Math.abs(e) > GRID_TOL_MS).length, 'in-flight rings off the grid after a stall').toBe(0);
});

// ---- iOS device reports (Dennel, 2026-11-01) ----
// iOS Safari can keep the AudioContext reporting 'running' while its clock has stopped:
// during Siri, and after the screen is locked and woken. These tests fake that by
// overriding audioCtx.currentTime on the instance (the engine's own clock is untouched).
async function freezeAudioClock(page) {
  return page.evaluate(() => {
    const proto = Object.getPrototypeOf(audioCtx);
    const real = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'currentTime').get;
    window.__frozenAt = real.call(audioCtx);
    window.__realCT = () => real.call(audioCtx);
    Object.defineProperty(audioCtx, 'currentTime', { configurable: true, get: () => window.__frozenAt });
    return window.__snapNow ? window.__snapNow() : null;   // state at the freeze instant
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
  await capturePauses(page);
  await startRun(page);
  await startBot(page);
  await page.waitForTimeout(4000);
  // Precondition: the Siri detector is armed. By design it arms only after 1.5 s of smooth
  // audio (no frame gap > 250 ms), so a jank-induced false pause can't happen. On a CI WebKit
  // that freezes the page every few seconds that can take longer than the old fixed 4 s.
  await page.waitForFunction(() => audioClockArmed() && (state === 'playing' || state === 'bossBattle'), null, { timeout: 30000 });
  const before = await snap(page);
  const atFreeze = await freezeAudioClock(page);            // Siri: state stays 'running', clock stops, page stays visible
  await page.waitForTimeout(2500);
  const during = await snap(page);
  expect(during.state, 'paused during Siri').toBe('paused');   // before trying to click Resume
  await thawAudioClock(page);
  const cd = await resumeAndCount(page);
  await page.waitForTimeout(7000);
  const grid = await gridAfter(page, during.nq);
  writeResult('phase2-ios-siri', { before, atFreeze, during, countdown: cd, gridAfterResumeMs: grid, ringsOnDroppedSteps: grid.dropped, errors });
  expect(errors).toEqual([]);
  expect(during.misses - atFreeze.misses, 'no misses from the frozen clock').toBe(0);
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
  writeResult('phase2-ios-lock', { back, r0, end, gridAfterResumeMs: grid, ringsOnDroppedSteps: grid.dropped, errors });
  expect(errors).toEqual([]);
  expect(back.state).toBe('paused');
  expect(r0.state).toBe('playing');
  expect(grid.length, 'rings spawn after waking + resume').toBeGreaterThanOrEqual(3);
  expect(grid.filter((e) => Math.abs(e) > GRID_TOL_MS).length).toBe(0);
  expect(end.steps - r0.steps, 'music plays after resume').toBeGreaterThan(20);
});
