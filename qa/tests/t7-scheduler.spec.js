const { test, expect } = require('@playwright/test');
const { boot, installProbes, startBot, writeResult } = require('./harness');

// Records every music scheduler tick (test-only, wraps setInterval before the game loads):
// tg = the game's own tick timestamp (musicLastTickWall), active = the tick reached the
// lookahead update (not paused/hidden/suspended), before/after = musicAhead around the tick,
// ac = audio clock at the tick, so ac + after is how far ahead that tick queued the music.
// Diagnostics only (no assertion uses them): ac2 = audio clock read again right after the tick,
// q = music.nextStepTime after the tick (where the queue really ended), qb = music.nextStepTime before
// the tick (where the queue ended when the tick began; qb <= m < q means this tick decided step m). Rhythm QA saw WebKit drop
// a step with 800 ms queued across a 0.49-0.62 s stall, which the scheduler can only do if the audio
// clock passed the queued step before its next tick; ac/ac2/q show whether the clock jumped.
// This lets T7 judge the lookahead against the timer gaps the game actually saw, on any engine.
async function recordMusicTicks(page) {
  await page.addInitScript(() => {
    const si = window.setInterval;
    window.__musicTicks = [];
    window.setInterval = function (fn, ms, ...rest) {
      if (typeof fn === 'function' && fn.name === 'musicTick') {
        const orig = fn;
        fn = function () {
          let before = null, ac = null, qb = null; try { before = musicAhead; ac = audioCtx && audioCtx.currentTime; qb = music.nextStepTime; } catch {}
          const r = orig.apply(this, arguments);
          let after = null, tg = 0, ac2 = null, q = null; try { after = musicAhead; tg = musicLastTickWall; ac2 = audioCtx && audioCtx.currentTime; q = music.nextStepTime; } catch {}
          window.__musicTicks.push({ t: performance.now(), tg, active: tg !== 0, before, after, ac, ac2, qb, q });
          return r;
        };
      }
      return si.call(this, fn, ms, ...rest);
    };
  });
}

// Required decay of the lookahead once the timer is on time again: at least 80 ms per second of wall
// time (the spec, independent of the game's constant, so a build that decays slower fails).
const REQUIRED_DECAY_PER_S = 0.08;

// Timer gap the game measured on each tick (0 when the previous tick didn't reach the update).
function withGaps(ticks) {
  return ticks.map((k, i) => ({ ...k, gap: (k.active && i > 0 && ticks[i - 1].active) ? (k.tg - ticks[i - 1].tg) / 1000 : 0 }));
}

// Diagnostics only: for a grid gap whose first missing step is due at audio time m, the last active
// tick before m (k) and the next active tick (n), with wall and audio-clock advance between them.
// If audio advanced more than k queued (q - ac) while wall advanced less, the engine's audio clock
// jumped ahead of the wall clock (bursty output); otherwise the scheduler dropped a step it had queued time for.
function gapDetail(m, ticks) {
  const act = ticks.filter((x) => x.active && x.ac != null);
  let i = -1; for (let j = 0; j < act.length; j++) if (act[j].ac < m) i = j;
  const r3 = (v) => (v == null ? null : +v.toFixed(3));
  const pick = (x) => x && { t: Math.round(x.t), ac: r3(x.ac), ac2: r3(x.ac2), qb: r3(x.qb), q: r3(x.q), before: r3(x.before), after: r3(x.after), gap: r3(x.gap) };
  const k = act[i], n = act[i + 1];
  const d = decidingTick(m, ticks);
  return { m: r3(m), k: pick(k), n: pick(n), wallAdv: k && n ? r3((n.tg - k.tg) / 1000) : null,
    audioAdv: k && n ? r3(n.ac - k.ac) : null, queuedPastK: k ? r3(k.q - k.ac) : null, inTickJump: k ? r3(k.ac2 - k.ac) : null,
    d: pick(d), dueVsD: d ? r3(m - d.ac) : null, cause: classifyGap(m, ticks) };
}

// The tick that moved the queue past step m (qb <= m < q): the only tick that could have scheduled m.
function decidingTick(m, ticks) {
  return ticks.find((x) => x.active && x.ac != null && x.qb != null && x.q != null && x.qb <= m + 1e-6 && m + 1e-6 < x.q) || null;
}

// A grid gap is a "stall" only if, when the deciding tick ran, step m was already due (m < ac + 2 ms,
// the game's never-schedule-into-the-past guard): the queue had run dry before that tick, because the
// timer gap before it was longer than the lookahead queued. Anything else is a "defect": the scheduler
// skipped a step it still had time to schedule, or no tick ever covered m.
// Was: judge by the last tick with ac < m and its queue AFTER the tick. When the late tick itself landed
// 0-2 ms before m (WebKit w4, Nov 5: m 8.389, tick ac 8.388 after a ~0.5 s gap), that tick's refilled
// queue made a real stall drop look like a defect.
function classifyGap(m, ticks) {
  const d = decidingTick(m, ticks);
  return d && m < d.ac + 0.002 ? 'stall' : 'defect';
}

// T7 (RV-14): scheduler headroom. With a fixed 140 ms lookahead, a 25 ms timer that fires
// ~300 ms late dropped every step due inside the gap, so the music stuttered on janky devices
// (seen on starved CI WebKit: 27-34 of ~50 steps scheduled). The lookahead now adapts to the
// worst recent timer gap. This test makes the jank on purpose (a 300 ms main-thread block every
// 700 ms) so it reproduces on any engine, then checks that every step the audio clock covered was
// scheduled (±10%), on the grid, and that the lookahead returns to 140 ms once the jank stops.
// Fails on the old build: about 1-2 steps dropped per block.
test('T7: steps keep up with the audio clock through repeated 300 ms main-thread stalls', async ({ page }) => {
  await recordMusicTicks(page);
  const errors = await boot(page);
  await installProbes(page);
  await page.click('#startBtn');
  await page.waitForFunction(() => state === 'playing');
  await page.waitForFunction(() => audioCtx && audioCtx.state === 'running' && music.on, null, { timeout: 5000 });
  await startBot(page);
  const w0 = await page.evaluate(() => {
    window.__jank = setInterval(() => { const t = performance.now(); while (performance.now() - t < 300) {} }, 700);
    return { wall: performance.now(), ac: audioCtx.currentTime, steps: __qa.wrapped.step, n: __qa.steps.length, q: music.nextStepTime };
  });
  await page.waitForTimeout(8000);
  const w1 = await page.evaluate(() => { clearInterval(window.__jank);
    return { wall: performance.now(), ac: audioCtx.currentTime, steps: __qa.wrapped.step, ahead: musicAhead, state, q: music.nextStepTime }; });
  const allSteps = await page.evaluate(() => __qa.steps);
  // Steps are counted by when they PLAY (when in [ac0, ac1)), against the audio time the music grid
  // actually covered in the window (from its first step, if the run's music started inside it).
  // Was: steps SCHEDULED during the wall window vs all audio time. That count shifts with how deep the
  // queue was at each end (up to 800 ms of start headroom at w0, up to 600 ms at w1 = several steps)
  // and counted audio time before the first step as missing steps, so it failed WebKit w4 with no gap
  // at all (Nov 5: 39 steps vs floor 39.0, gaps 0). Same ±10% bounds, on what was heard.
  const win = allSteps.filter((x) => x.when >= w0.ac && x.when < w1.ac);
  const gridFrom = allSteps.length ? Math.max(w0.ac, allSteps[0].when) : w0.ac;
  const audioS = w1.ac - w0.ac, gridS = w1.ac - gridFrom, stepsIn = win.length, scheduledIn = w1.steps - w0.steps;
  const avgDur = win.reduce((a, x) => a + x.stepDur, 0) / Math.max(1, win.length);
  const lo = 0.9 * gridS / avgDur, hi = 1.1 * gridS / avgDur;
  let gaps = 0; for (let i = 1; i < win.length; i++) if (win[i].when - win[i - 1].when > 1.5 * win[i - 1].stepDur) gaps++;
  // After the jank stops, the lookahead must decay (no permanent latency).
  await page.waitForTimeout(6000);
  const settled = await page.evaluate(() => ({ ahead: musicAhead, min: MUSIC_AHEAD_MIN, max: MUSIC_AHEAD_MAX,
    margin: MUSIC_AHEAD_MARGIN, ticks: window.__musicTicks.slice() }));
  const ticks = withGaps(settled.ticks);
  // Classify each grid gap by the tick that moved the queue past the first missing step m (see
  // classifyGap): "stall" if m was already due when that tick ran (the timer gap before it outran the
  // lookahead; the design adapts to the worst gap so far, capped at MUSIC_AHEAD_MAX, and can't cover a
  // bigger one), else "defect" (the scheduler skipped a step it had time for).
  const jank = ticks.filter((k) => k.t > w0.wall && k.t <= w1.wall + 1);
  let stallGaps = 0, defectGaps = 0;
  for (let i = 1; i < win.length; i++) {
    if (!(win[i].when - win[i - 1].when > 1.5 * win[i - 1].stepDur)) continue;
    const m = win[i - 1].when + win[i - 1].stepDur;
    if (classifyGap(m, ticks) === 'stall') stallGaps++; else defectGaps++;
    console.log('t7-gap-detail jank ' + JSON.stringify(gapDetail(m, ticks)));
  }
  // Settle bound, replayed from the timer gaps the game saw after the jank stopped: each raise to
  // min(max, gap + margin) and the jank-time value, minus decay per second of wall time since.
  const after = ticks.filter((k) => k.t > w1.wall + 1);
  const inactiveAfter = after.filter((k) => !k.active).length;
  const tLast = after.length ? after[after.length - 1].tg : w1.wall;
  const R = REQUIRED_DECAY_PER_S;
  let bound = Math.max(settled.min, w1.ahead - R * (tLast - w1.wall) / 1000);
  for (const k of after) if (k.active) bound = Math.max(bound, Math.min(settled.max, k.gap + settled.margin) - R * (tLast - k.tg) / 1000);
  const worstGapAfter = after.reduce((m, k) => Math.max(m, k.gap), 0);
  const res = { audioS: +audioS.toFixed(2), gridS: +gridS.toFixed(2), wallS: +((w1.wall - w0.wall) / 1000).toFixed(2), steps: stepsIn, scheduledIn,
    queuedAtW0: +(w0.q - w0.ac).toFixed(3), queuedAtW1: +(w1.q - w1.ac).toFixed(3),
    expected: [+lo.toFixed(1), +hi.toFixed(1)], gaps, stallGaps, defectGaps, worstJankGap: +jank.reduce((m, k) => Math.max(m, k.gap), 0).toFixed(3),
    aheadDuringJank: +w1.ahead.toFixed(3), aheadSettled: +settled.ahead.toFixed(3), settleBound: +bound.toFixed(3),
    worstGapAfterJank: +worstGapAfter.toFixed(3), ticksAfterJank: after.length, inactiveAfter, state: w1.state };
  writeResult('t7-scheduler', { res, errors });
  console.log('t7-scheduler ' + JSON.stringify(res));
  expect(stepsIn, 'steps vs audio clock under jank: ' + JSON.stringify(res)).toBeGreaterThanOrEqual(lo);
  expect(stepsIn, 'steps vs audio clock under jank: ' + JSON.stringify(res)).toBeLessThanOrEqual(hi);
  // Was "gaps <= 1" whatever the cause. Now: 0 defect gaps (stricter), and stall gaps, where the timer
  // stalled past the queued lookahead (on WebKit a 300 ms block can stack on a tick that is already
  // ~300 ms late), are counted and logged; the ±10% step check above still bounds how many there are.
  expect(defectGaps, 'grid gaps the scheduler had queued time for (dropped steps): ' + JSON.stringify(res)).toBe(0);
  expect(w1.ahead, 'lookahead grew to cover the stall').toBeGreaterThan(0.3);
  expect(w1.ahead).toBeLessThanOrEqual(settled.max);
  // No permanent latency: 6 s after the jank, the lookahead is no higher than the timer gaps since then
  // justify (5 ms tolerance). On a quiet timer that is the 140 ms floor (+ one ordinary headless gap);
  // where the timer keeps firing late (WebKit), it may stay up, but only by what those gaps require.
  // Was a fixed "floor + 60 ms", which assumed a quiet timer and failed WebKit 0/40.
  expect(inactiveAfter, 'scheduler stopped ticking during the settle window (paused/suspended): inconclusive ' + JSON.stringify(res)).toBe(0);
  expect(settled.ahead, 'lookahead decays to what recent timer gaps justify: ' + JSON.stringify(res)).toBeLessThanOrEqual(bound + 0.005);
  expect(settled.ahead).toBeGreaterThanOrEqual(settled.min);
  // Every raise is justified by the gap that caused it (catches a lookahead that ratchets up on its own).
  const bad = ticks.filter((k) => k.active && k.after > k.before + 1e-9 && k.after > Math.min(settled.max, k.gap + settled.margin) + 0.005);
  expect(bad.length, 'lookahead raised beyond gap + margin: ' + JSON.stringify(bad.slice(0, 3))).toBe(0);
  expect(errors, errors.join('\n')).toEqual([]);
});

// T7: the first seconds of a run are the jankiest (CI WebKit stalled 461 ms right after start and
// dropped 3 steps before the lookahead could adapt). Each run starts with 800 ms of headroom, held
// (not decayed) for the first 2 s, so one 450 ms stall just after start drops nothing even when
// the engine's timer was already ~300 ms late going into it (WebKit failed 9/40 with a 500 ms start
// that had begun decaying). Checks, all on the ticks the game itself saw:
//  - headroom: every active tick in the first 2 s (before the stall) kept musicAhead at the start value.
//  - 0 "defect" gaps: no missing step that the last tick before it had already queued time for.
//  - 0 gaps at all unless the game's own timer gap across the stall exceeded both the required 750 ms
//    and the headroom actually queued (stall + the engine's lateness beyond it): only then is a gap logged as a "stall" gap, with the
//    gap that caused it. Was "0 gaps of any kind"; that also failed when the box/engine, not the
//    game, outran any headroom within the design cap. The headroom check is new and stricter: it
//    fails a build that decays before the stall even when no step happens to drop.
// Fails with a 140 ms or 500 ms-decaying start (headroom check), or a scheduler that drops queued steps.
// Spec value, independent of the game's constant: 450 ms stall + ~300 ms late WebKit tick.
const REQUIRED_START_AHEAD = 0.75;
test('T7: a single 450 ms stall right after the run starts drops no steps', async ({ page }) => {
  await recordMusicTicks(page);
  const errors = await boot(page);
  await installProbes(page);
  await page.click('#startBtn');
  await page.waitForFunction(() => state === 'playing');
  await page.waitForFunction(() => audioCtx && audioCtx.state === 'running' && music.on, null, { timeout: 5000 });
  // Stall only once the recorder has seen an active scheduler tick. startMusic()'s own first tick is
  // a direct call the setInterval wrapper can't see, so stalling before the first interval tick left
  // no pre-stall tick to measure from (Chromium w4, Nov 5: stallGap null, preTicks 0). Still ~25 ms in.
  await page.waitForFunction(() => window.__musicTicks.some((k) => k.active), null, { timeout: 5000 });
  const pre = await page.evaluate(() => ({ n: __qa.steps.length, start: MUSIC_AHEAD_START, min: MUSIC_AHEAD_MIN }));
  const t0 = await page.evaluate(() => { const t = performance.now(); while (performance.now() - t < 450) {} return t; });
  await page.waitForTimeout(1500);
  const r = await page.evaluate((n0) => ({ w: __qa.steps.slice(Math.max(0, n0 - 1)), ahead: musicAhead, ticks: window.__musicTicks.slice() }), pre.n);
  const ticks = withGaps(r.ticks).filter((k) => k.active);
  const w = r.w;
  const before = ticks.filter((k) => k.t <= t0);
  const lastPre = before[before.length - 1];
  const firstPost = ticks.find((k) => k.t > t0);
  const stallGap = lastPre && firstPost ? +((firstPost.tg - lastPre.tg) / 1000).toFixed(3) : null;
  let gaps = 0, stallGaps = 0, defectGaps = 0;
  for (let i = 1; i < w.length; i++) {
    if (!(w[i].when - w[i - 1].when > 1.5 * w[i - 1].stepDur)) continue;
    gaps++;
    const m = w[i - 1].when + w[i - 1].stepDur;
    // Judge the gap by the timer gap that actually starved the queue: the one just before the tick that
    // decided m (same classifier as the jank test). It is a "stall" only if m was already due when that
    // tick ran AND that timer gap was longer than both the required 750 ms and what the previous tick
    // had really queued (q - ac). Otherwise it is a defect: the start headroom should have covered it.
    // Was: the last tick with ac < m, its lookahead (not its real queue), and always the test's own
    // 450 ms stall gap. That called a drop after a later, separate long gap a defect of the start
    // headroom (WebKit w4, Nov 5: stallGap 0.546, but the deciding tick ran 0.21 s after m was due).
    const d = decidingTick(m, ticks);
    const prev = d ? ticks.filter((x) => x.t < d.t).pop() : null;
    const starveGap = d && prev ? (d.tg - prev.tg) / 1000 : null;
    const prevQueue = prev && prev.q != null && prev.ac != null ? prev.q - prev.ac : null;
    const isStall = classifyGap(m, ticks) === 'stall' && starveGap != null && prevQueue != null &&
      starveGap > Math.max(REQUIRED_START_AHEAD, prevQueue);
    if (isStall) stallGaps++; else defectGaps++;
    const r3 = (v) => (v == null ? null : +v.toFixed(3));
    console.log('t7-gap-detail start ' + JSON.stringify({ ...gapDetail(m, ticks), starveGap: r3(starveGap), prevQueue: r3(prevQueue),
      starvedByTestStall: !!(prev && lastPre && prev === lastPre), counted: isStall ? 'stall' : 'defect' }));
  }
  // Diagnostics only: how far the audio clock moved across the stall, next to the wall gap.
  const stallAudio = lastPre && firstPost && lastPre.ac != null && firstPost.ac != null ? +(firstPost.ac - lastPre.ac).toFixed(3) : null;
  const held = before.every((k) => Math.abs(k.after - pre.start) < 1e-6);
  // New, stricter: the queue each pre-stall tick really left (q - ac), not just musicAhead.
  const preQueueMin = before.length && before.every((k) => k.q != null && k.ac != null) ? Math.min(...before.map((k) => k.q - k.ac)) : null;
  const res = { gaps, stallGaps, defectGaps, stallGap, stallAudio, held, preQueueMin: preQueueMin == null ? null : +preQueueMin.toFixed(3), preTicks: before.length,
    aheadBeforeStall: lastPre ? +lastPre.after.toFixed(3) : null, aheadAfter: +r.ahead.toFixed(3), steps: w.length };
  console.log('t7-start-stall ' + JSON.stringify(res));
  expect(stallGap, 'the game saw the 450 ms stall as one timer gap: ' + JSON.stringify(res)).toBeGreaterThanOrEqual(0.44);
  expect(before.length, 'scheduler ticked before the stall: ' + JSON.stringify(res)).toBeGreaterThan(0);
  expect(held, 'start headroom held (not decayed) before the stall: ' + JSON.stringify(res)).toBe(true);
  expect(preQueueMin, 'every pre-stall tick really queued the required start headroom: ' + JSON.stringify(res)).toBeGreaterThanOrEqual(REQUIRED_START_AHEAD);
  expect(pre.start, 'start headroom covers a 450 ms stall plus a ~300 ms late tick').toBeGreaterThanOrEqual(REQUIRED_START_AHEAD);
  expect(w.length, 'steps scheduled after the stall').toBeGreaterThan(4);
  expect(defectGaps, 'grid gaps (dropped steps) the start headroom should have covered: ' + JSON.stringify(res)).toBe(0);
  expect(stallGaps, 'at most one step lost, and only to a timer gap beyond the full start headroom: ' + JSON.stringify(res)).toBeLessThanOrEqual(1);
  expect(errors, errors.join('\n')).toEqual([]);
});
