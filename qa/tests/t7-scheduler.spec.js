const { test, expect } = require('@playwright/test');
const { boot, installProbes, startBot, writeResult } = require('./harness');

// Records every music scheduler tick (test-only, wraps setInterval before the game loads):
// tg = the game's own tick timestamp (musicLastTickWall), active = the tick reached the
// lookahead update (not paused/hidden/suspended), before/after = musicAhead around the tick,
// ac = audio clock at the tick, so ac + after is how far ahead that tick queued the music.
// Diagnostics only (no assertion uses them): ac2 = audio clock read again right after the tick,
// q = music.nextStepTime after the tick (where the queue really ended). Rhythm QA saw WebKit drop
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
          let before = null, ac = null; try { before = musicAhead; ac = audioCtx && audioCtx.currentTime; } catch {}
          const r = orig.apply(this, arguments);
          let after = null, tg = 0, ac2 = null, q = null; try { after = musicAhead; tg = musicLastTickWall; ac2 = audioCtx && audioCtx.currentTime; q = music.nextStepTime; } catch {}
          window.__musicTicks.push({ t: performance.now(), tg, active: tg !== 0, before, after, ac, ac2, q });
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
  const pick = (x) => x && { t: Math.round(x.t), ac: r3(x.ac), ac2: r3(x.ac2), q: r3(x.q), after: r3(x.after) };
  const k = act[i], n = act[i + 1];
  return { m: r3(m), k: pick(k), n: pick(n), wallAdv: k && n ? r3((n.tg - k.tg) / 1000) : null,
    audioAdv: k && n ? r3(n.ac - k.ac) : null, queuedPastK: k ? r3(k.q - k.ac) : null, inTickJump: k ? r3(k.ac2 - k.ac) : null };
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
    return { wall: performance.now(), ac: audioCtx.currentTime, steps: __qa.wrapped.step, n: __qa.steps.length };
  });
  await page.waitForTimeout(8000);
  const w1 = await page.evaluate(() => { clearInterval(window.__jank);
    return { wall: performance.now(), ac: audioCtx.currentTime, steps: __qa.wrapped.step, ahead: musicAhead, state }; });
  const win = (await page.evaluate(() => __qa.steps)).slice(w0.n);
  const audioS = w1.ac - w0.ac, stepsIn = w1.steps - w0.steps;
  const avgDur = win.reduce((a, x) => a + x.stepDur, 0) / Math.max(1, win.length);
  const lo = 0.9 * audioS / avgDur, hi = 1.1 * audioS / avgDur;
  let gaps = 0; for (let i = 1; i < win.length; i++) if (win[i].when - win[i - 1].when > 1.5 * win[i - 1].stepDur) gaps++;
  // After the jank stops, the lookahead must decay (no permanent latency).
  await page.waitForTimeout(6000);
  const settled = await page.evaluate(() => ({ ahead: musicAhead, min: MUSIC_AHEAD_MIN, max: MUSIC_AHEAD_MAX,
    margin: MUSIC_AHEAD_MARGIN, ticks: window.__musicTicks.slice() }));
  const ticks = withGaps(settled.ticks);
  // Classify each grid gap. The first missing step at audio time m was due after the last active
  // tick before m. If that tick had queued music only up to ac + after < m, the timer stall outran
  // the lookahead queued at that moment ("stall": the design adapts to the worst gap so far, capped
  // at MUSIC_AHEAD_MAX, and can't cover a bigger one). If it had queued past m and m is still
  // missing, the scheduler dropped a step it had time for ("defect").
  const jank = ticks.filter((k) => k.t > w0.wall && k.t <= w1.wall + 1);
  let stallGaps = 0, defectGaps = 0;
  for (let i = 1; i < win.length; i++) {
    if (!(win[i].when - win[i - 1].when > 1.5 * win[i - 1].stepDur)) continue;
    const m = win[i - 1].when + win[i - 1].stepDur;
    let k = null; for (const x of ticks) if (x.active && x.ac != null && x.ac < m) k = x;
    if (k && k.ac + k.after < m + 0.002) stallGaps++; else defectGaps++;
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
  const res = { audioS: +audioS.toFixed(2), wallS: +((w1.wall - w0.wall) / 1000).toFixed(2), steps: stepsIn,
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
    let k = null; for (const x of ticks) if (x.ac != null && x.ac < m) k = x;
    if (k && k.ac + k.after < m + 0.002 && stallGap != null && stallGap > Math.max(REQUIRED_START_AHEAD, lastPre.after)) stallGaps++; else defectGaps++;
    console.log('t7-gap-detail start ' + JSON.stringify(gapDetail(m, ticks)));
  }
  // Diagnostics only: how far the audio clock moved across the stall, next to the wall gap.
  const stallAudio = lastPre && firstPost && lastPre.ac != null && firstPost.ac != null ? +(firstPost.ac - lastPre.ac).toFixed(3) : null;
  const held = before.every((k) => Math.abs(k.after - pre.start) < 1e-6);
  const res = { gaps, stallGaps, defectGaps, stallGap, stallAudio, held, preTicks: before.length,
    aheadBeforeStall: lastPre ? +lastPre.after.toFixed(3) : null, aheadAfter: +r.ahead.toFixed(3), steps: w.length };
  console.log('t7-start-stall ' + JSON.stringify(res));
  expect(stallGap, 'the game saw the 450 ms stall as one timer gap: ' + JSON.stringify(res)).toBeGreaterThanOrEqual(0.44);
  expect(before.length, 'scheduler ticked before the stall: ' + JSON.stringify(res)).toBeGreaterThan(0);
  expect(held, 'start headroom held (not decayed) before the stall: ' + JSON.stringify(res)).toBe(true);
  expect(pre.start, 'start headroom covers a 450 ms stall plus a ~300 ms late tick').toBeGreaterThanOrEqual(REQUIRED_START_AHEAD);
  expect(w.length, 'steps scheduled after the stall').toBeGreaterThan(4);
  expect(defectGaps, 'grid gaps (dropped steps) the start headroom should have covered: ' + JSON.stringify(res)).toBe(0);
  expect(stallGaps, 'at most one step lost, and only to a timer gap beyond the full start headroom: ' + JSON.stringify(res)).toBeLessThanOrEqual(1);
  expect(errors, errors.join('\n')).toEqual([]);
});
