// SCRATCH (Jarvis, 2026-10-31): extra Phase 1 checks for T3 (min gap) and T5 (full first approach).
const { test, expect } = require('@playwright/test');
const { boot, installProbes, startBot, stats, writeResult } = require('./harness');
for (const vibe of ['cyberBounce', 'goldGroove']) {
  test(`phase1 extra (${vibe}): lead time, min gap, density`, async ({ page }) => {
    const errors = await boot(page, { save: { settings: { musicVibe: vibe } } });
    await installProbes(page);
    await page.click('#startBtn');
    await page.waitForFunction(() => state === 'playing');
    await startBot(page);
    await page.waitForTimeout(6000);
    await page.evaluate(() => { hitsTotal = stageHitsNeeded(6, diff) - 2; });
    await page.waitForTimeout(30000);
    const r = await page.evaluate(() => ({ notes: __qa.notes, minGap: Math.max(MIN_NOTE_GAP, windows().ok * 1.7), taps: __qa.taps }));
    const live = r.notes.filter((n) => !n.cleared);
    const leadShort = live.filter((n) => (n.hitTime - n.nowG) < n.leadTime - 1 / 60).map((n) => ({ stage: n.stage, ready: n.ready, skippedPct: +(100 * (1 - (n.hitTime - n.nowG) / n.leadTime)).toFixed(1) }));
    const sorted = [...live].sort((a, b) => a.hitTime - b.hitTime);
    const gaps = []; for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i].hitTime - sorted[i - 1].hitTime);
    const tooClose = gaps.filter((g) => g < r.minGap - 1e-6);
    const perStage = live.reduce((m, n) => (m[n.stage] = (m[n.stage] || 0) + 1, m), {});
    const first = sorted[0] ? { nowG: sorted[0].nowG, hitTime: sorted[0].hitTime, lead: sorted[0].leadTime, ready: sorted[0].ready } : null;
    const res = { vibe, game: process.env.GAME_DIR, liveNotes: live.length, cleared: r.notes.length - live.length, first, leadShortCount: leadShort.length, leadShort: leadShort.slice(0, 10),
      minGapS: r.minGap, tooCloseCount: tooClose.length, minObservedGapS: Math.min(...gaps), perStage,
      botResults: r.taps.reduce((m, t) => (m[t.res] = (m[t.res] || 0) + 1, m), {}), errors };
    writeResult('phase1-extra-' + vibe, res);
    expect(errors).toEqual([]);
    expect.soft(res.leadShortCount, 'notes with < full approach').toBe(0);
    expect.soft(res.tooCloseCount, 'notes closer than minGap').toBe(0);
  });
}
