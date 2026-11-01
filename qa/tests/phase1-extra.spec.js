// Phase 1 extra checks for T3 (min gap) and T5 (full first approach). v2 (Jarvis, 2026-10-31).
// v2 change: minGap = max(MIN_NOTE_GAP, windows().ok * 1.7) is recorded PER NOTE at spawn time,
// because windows() depends on the stage (and is floored during boss fights). v1 computed it once
// at the end of the run and applied it to every pair, which can flag legal pairs from an earlier
// stage (false alarm) or miss real ones (false pass) depending on how the window moved.
// Each pair is judged by the rule in force when the later note was scheduled (same as rv08-soak).
const { test, expect } = require('@playwright/test');
const { boot, installProbes, startBot, writeResult } = require('./harness');
for (const vibe of ['cyberBounce', 'goldGroove']) {
  test(`phase1 extra v2 (${vibe}): lead time, per-stage min gap, density`, async ({ page }) => {
    const errors = await boot(page, { save: { settings: { musicVibe: vibe } } });
    await installProbes(page);
    // tag each probe record with the min-gap rule in force when that note was spawned
    await page.evaluate(() => {
      const prev = spawnNote;
      window.spawnNote = function (hitTime, index) {
        const r = prev.apply(this, arguments);
        const q = __qa.notes[__qa.notes.length - 1];
        if (q && q.hitTime === hitTime) { q.minGap = Math.max(MIN_NOTE_GAP, windows().ok * 1.7); q.boss = !!bossActive; }
        return r;
      };
    });
    await page.click('#startBtn');
    await page.waitForFunction(() => state === 'playing');
    await startBot(page);
    await page.waitForTimeout(6000);
    await page.evaluate(() => { hitsTotal = stageHitsNeeded(6, diff) - 2; });
    await page.waitForTimeout(30000);
    const r = await page.evaluate(() => ({ notes: __qa.notes, endMinGap: Math.max(MIN_NOTE_GAP, windows().ok * 1.7), taps: __qa.taps }));
    const live = r.notes.filter((n) => !n.cleared);
    const untagged = live.filter((n) => typeof n.minGap !== 'number').length;
    const leadShort = live.filter((n) => (n.hitTime - n.nowG) < n.leadTime - 1 / 60).map((n) => ({ stage: n.stage, ready: n.ready, skippedPct: +(100 * (1 - (n.hitTime - n.nowG) / n.leadTime)).toFixed(1) }));
    const sorted = [...live].sort((a, b) => a.hitTime - b.hitTime);
    const close = [], gaps = [];
    let v1WouldFlag = 0;
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1], b = sorted[i], g = b.hitTime - a.hitTime;
      gaps.push(g);
      if (g < r.endMinGap - 1e-6) v1WouldFlag++;
      if (g < b.minGap - 1e-6) close.push({ gapMs: +(g * 1000).toFixed(1), minGapMs: +(b.minGap * 1000).toFixed(1), stage: b.stage, boss: b.boss });
    }
    const minGapByStage = {};
    for (const n of live) (minGapByStage[n.stage] ||= new Set()).add(+(n.minGap * 1000).toFixed(1));
    const perStage = live.reduce((m, n) => (m[n.stage] = (m[n.stage] || 0) + 1, m), {});
    const first = sorted[0] ? { nowG: sorted[0].nowG, hitTime: sorted[0].hitTime, lead: sorted[0].leadTime, ready: sorted[0].ready } : null;
    const res = { vibe, game: process.env.GAME_DIR, liveNotes: live.length, cleared: r.notes.length - live.length, untagged, first,
      leadShortCount: leadShort.length, leadShort: leadShort.slice(0, 10),
      tooCloseCount: close.length, tooClose: close.slice(0, 10), v1EndOfRunFlagCount: v1WouldFlag, endMinGapMs: +(r.endMinGap * 1000).toFixed(1),
      minGapMsByStage: Object.fromEntries(Object.entries(minGapByStage).map(([k, v]) => [k, [...v]])),
      minObservedGapS: gaps.length ? Math.min(...gaps) : null, perStage,
      botResults: r.taps.reduce((m, t) => (m[t.res] = (m[t.res] || 0) + 1, m), {}), errors };
    writeResult('phase1-extra-v2-' + vibe, res);
    console.log(JSON.stringify({ vibe, live: res.liveNotes, leadShort: res.leadShortCount, tooClose: res.tooCloseCount, v1Flag: res.v1EndOfRunFlagCount, minGapMsByStage: res.minGapMsByStage }));
    expect(errors).toEqual([]);
    expect(untagged, 'every live note has a recorded minGap').toBe(0);
    expect.soft(res.leadShortCount, 'notes with < full approach').toBe(0);
    expect.soft(res.tooCloseCount, 'notes closer than the minGap in force when they were scheduled').toBe(0);
  });
}
