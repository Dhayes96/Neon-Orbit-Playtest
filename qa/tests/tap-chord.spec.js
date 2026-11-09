// Rhythm-bot step 2 regression checks (automated, headless).
//  1. A chosen song survives a reload, including unlocked reward songs (was: reset to Void Metal).
//  2. audibleBar() matches the bar actually sounding (from the sequencer's own schedule), while
//     music.bar, the scheduler's bar, runs ahead of it near every bar end.
//  3. Classic tap voice: every pitch it plays is a tone of the chord sounding at that moment.
//   npx playwright test tests/tap-chord.spec.js --project=desktop-chrome
const { test, expect } = require('@playwright/test');
const { boot } = require('./harness');

const cases = [
  ['cybermetal', { cybermetal: true }, 'cybermetal'],
  ['ascension', { ascension: true }, 'ascension'],
  ['cybermetal', { cybermetal: false }, 'voidMetal'],   // locked reward song: not kept
  ['hellfire', {}, 'voidMetal'],                         // DOOM-only song: not kept
  ['bogus', {}, 'voidMetal'],
  ['darkWave', {}, 'darkWave'],
];
for (const [v, un, want] of cases) {
  test(`song ${v} ${JSON.stringify(un)} -> ${want} after reload`, async ({ page }) => {
    const errors = await boot(page, { save: { level: 20, vibeUnlocks: un, settings: { musicVibe: v } } });
    expect(await page.evaluate(() => save.settings.musicVibe)).toBe(want);
    await page.evaluate(() => persist());
    await page.reload();
    await page.waitForFunction(() => typeof state === 'string');
    expect(await page.evaluate(() => save.settings.musicVibe)).toBe(want);
    expect(errors).toEqual([]);
  });
}

async function startSong(page, vibe) {
  await boot(page, { save: { level: 20, settings: { musicVibe: vibe, autoMatchVibe: false, lowGraphics: true } } });
  await page.click('#startBtn');
  await page.waitForFunction(() => audioCtx && audioCtx.state === 'running' && music.on);
  await page.evaluate(() => {
    const s = window.__sched = []; const prev = window.scheduleStep;
    window.scheduleStep = function (step, when) {
      const ph = music.active.phase; const slot = music.bar % ph.prog.length;
      s.push({ when, bar: music.bar, root: ph.prog[slot] + (music.active.transpose || 0), q: ph.quality[slot] });
      return prev.apply(this, arguments);
    };
  });
  await page.waitForTimeout(1500);   // let the pre-hook lookahead play out
}

test('audibleBar() is the bar being heard; music.bar runs ahead', async ({ page }) => {
  await startSong(page, 'voidMetal');
  const r = await page.evaluate(async () => {
    let n = 0, mismatch = 0, ahead = 0;
    for (let i = 0; i < 400; i++) {
      await new Promise((res) => setTimeout(res, 20));
      const ac = audioCtx.currentTime; let truth = null;
      for (let j = __sched.length - 1; j >= 0; j--) if (__sched[j].when <= ac) { truth = __sched[j].bar; break; }
      if (truth == null) continue;
      n++; if (audibleBar() !== truth) mismatch++; if (music.bar !== truth) ahead++;
    }
    return { n, mismatch, ahead };
  });
  console.log('audibleBar', JSON.stringify(r));
  expect(r.n).toBeGreaterThan(300);
  expect(r.ahead).toBeGreaterThan(0);        // proves the probe can see the old bug
  expect(r.mismatch).toBe(0);
});

for (const vibe of ['voidMetal', 'cyberBounce', 'darkWave']) {
  test(`Classic tap pitches are chord tones (${vibe})`, async ({ page }) => {
    await startSong(page, vibe);
    const r = await page.evaluate(async () => {
      const hz2pc = (f) => ((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12;
      const played = []; const origTone = window.tone;
      let bad = 0, n = 0;
      for (let i = 0; i < 60; i++) {
        await new Promise((res) => setTimeout(res, 37));
        const ac = audioCtx.currentTime; let ch = null;
        for (let j = __sched.length - 1; j >= 0; j--) if (__sched[j].when <= ac) { ch = __sched[j]; break; }
        if (!ch) continue;
        const tones = ch.q.map((x) => (ch.root + x) % 12);
        const grade = ['perfect', 'good', 'ok', 'miss'][i % 4];
        const fs = []; window.tone = (f) => { fs.push(f); };
        try { TapVoice.play(grade); } finally { window.tone = origTone; }
        if (!fs.length) continue;
        n++; if (!fs.every((f) => tones.includes(hz2pc(f)))) { bad++; played.push({ grade, fs, tones }); }
      }
      return { n, bad, sample: played.slice(0, 3) };
    });
    console.log(`classic ${vibe}`, JSON.stringify(r));
    expect(r.n).toBeGreaterThan(40);
    expect(r.bad).toBe(0);
  });
}
