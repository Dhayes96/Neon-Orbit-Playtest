// T3 / RV-08: deterministic pattern-boundary test.
// Two consecutive scheduleNotes() calls each schedule one 1-beat pattern:
//   A = { offsets: [0.5] } starting on step 12 of a bar -> its note is on step 14
//   B = { offsets: [0]   } starting on step 16 (next downbeat)
// Accents are stubbed to bar downbeats only, so A's note snaps +2 steps onto
// step 16, exactly where B's first note lands. The un-snapped gap is half a
// beat (> minGap), so only the accent snap can create the clash.
// Before the fix the min-gap check restarts per pattern and both notes spawn;
// after it, B's note is dropped. Everything runs inside one page.evaluate so
// the game loop can't interleave; the field is cleared and restored after.
const { test, expect } = require('@playwright/test');
const { boot, writeResult } = require('./harness');

test('RV-08: min gap holds across a pattern boundary when the accent snap pulls notes together', async ({ page }) => {
  const errors = await boot(page, { save: { settings: { musicVibe: 'cyberBounce' } } });
  await page.click('#startBtn');
  await page.waitForFunction(() => state === 'playing' && Conductor.ready() && audioCtx.state === 'running', null, { timeout: 10000 });
  await page.waitForTimeout(500);
  const r = await page.evaluate(() => {
    const origChoose = chooseRhythmPattern, origAccent = accentSteps;
    const resetLast = () => { try { lastScheduledHitT = -Infinity; } catch (e) { /* not defined before the fix */ } };
    const tReal = clockNow() - startTime;
    const sd = Conductor.stepDur(), beat = Conductor.beatDur();
    const minGap = Math.max(MIN_NOTE_GAP, windows().ok * 1.7);
    // first absolute step k >= now + lead with k % 16 === 12
    let k = Math.ceil(Conductor.stepAt(tReal + leadTime + 0.05));
    while (((k % 16) + 16) % 16 !== 12) k++;
    const S = Conductor.audioToGame(music.nextStepTime + (k - music.step) * sd);
    const pats = [{ offsets: [0.5], span: 1 }, { offsets: [0], span: 1 }];
    let call = 0;
    window.chooseRhythmPattern = () => pats[Math.min(call++, 1)];
    window.accentSteps = () => [0];
    moveArmed = false;
    notes = []; resetLast();
    nextBeatTime = S;
    const t1 = S - leadTime - 0.3;          // exactly one pattern fits in each call
    scheduleNotes(t1);
    scheduleNotes(t1 + beat);
    window.chooseRhythmPattern = origChoose; window.accentSteps = origAccent;
    const hits = notes.map((n) => n.hitTime).sort((a, b) => a - b);
    const steps = hits.map((h) => +(Conductor.stepAt(h) - k).toFixed(3));   // relative to pattern A's start
    const gaps = []; for (let i = 1; i < hits.length; i++) gaps.push(hits[i] - hits[i - 1]);
    // restore a clean field so the run continues normally
    notes = []; resetLast(); nextBeatTime = (clockNow() - startTime) + leadTime + 0.2;
    return { patternsScheduled: call, bpm, minGap, unsnappedGapS: 0.5 * beat, spawned: hits.length, stepsFromA: steps,
      gapsS: gaps, tooClose: gaps.filter((g) => g < minGap - 1e-6).length };
  });
  writeResult('rv08-gap', { ...r, errors });
  expect(r.patternsScheduled, 'both patterns were scheduled').toBe(2);
  expect(r.unsnappedGapS, 'scenario: the un-snapped gap is legal').toBeGreaterThan(r.minGap);
  expect(r.stepsFromA[0], "scenario: A's note snapped onto the downbeat (step +4)").toBeCloseTo(4, 2);
  expect(r.tooClose, 'notes closer than minGap across the pattern boundary').toBe(0);
  expect(errors).toEqual([]);
});
