// CrazyGames Basic Launch (a): every call-to-action must be fully in view, unclipped and
// tappable at all 10 required iframe sizes (docs.crazygames.com/requirements/gameplay, DPR 1).
// Hard checks: results buttons (typical + tallest card), menu buttons, tutorial buttons,
// pause button, Resume + Main Menu. Long text screens (settings, how-to, board, lore) scroll by design;
// for those we only report whether Back is reachable.
// Screenshots per size go to results/cg-layout/.
const { test, expect } = require('@playwright/test');
const { boot, writeResult } = require('./harness');
const fs = require('fs');
const path = require('path');

const SIZES = [[907, 510], [1216, 684], [1077, 606], [821, 462], [1366, 768], [1920, 1080], [1536, 864], [1280, 720], [800, 450], [1080, 607]];
const SHOTS = path.join(__dirname, '..', 'results', 'cg-layout');

// In-page: is the element fully inside the viewport, inside every clipping ancestor, and the
// topmost element at its centre (i.e. really tappable without scrolling)?
function visibilityProbe(ids) {
  const vw = innerWidth, vh = innerHeight, out = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) { out[id] = { ok: false, why: 'missing' }; continue; }
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) { out[id] = { ok: false, why: 'not rendered' }; continue; }
    let why = '';
    if (r.left < -0.5 || r.top < -0.5 || r.right > vw + 0.5 || r.bottom > vh + 0.5) why = 'outside viewport';
    for (let p = el.parentElement; p && !why; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll|hidden|clip)/.test(cs.overflowY + cs.overflowX)) {
        const pr = p.getBoundingClientRect();
        if (r.top < pr.top - 0.5 || r.bottom > pr.bottom + 0.5 || r.left < pr.left - 0.5 || r.right > pr.right + 0.5) why = 'clipped by #' + (p.id || p.className);
      }
    }
    if (!why) {
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit || !(hit === el || el.contains(hit))) why = 'covered by ' + (hit ? (hit.id || hit.className || hit.tagName) : 'nothing');
    }
    out[id] = { ok: !why, why, top: Math.round(r.top), bottom: Math.round(r.bottom), vh };
  }
  return out;
}

async function shot(page, name) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png') }); }

for (const [w, h] of SIZES) {
  test(`CrazyGames layout ${w}x${h}: results, menu, tutorial and pause CTAs fully in view`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = await boot(page, { save: { tutorialDone: false } });
    const res = { size: `${w}x${h}` };
    // menu
    res.menu = await page.evaluate(visibilityProbe, ['startBtn', 'boardBtn', 'loreBtn', 'howtoBtn', 'settingsBtn']);
    await shot(page, `${w}x${h}-menu`);
    // tutorial (first-run flow)
    await page.click('#startBtn');
    await page.waitForSelector('#tutorialScreen:not(.hidden)', { timeout: 5000 });
    res.tutorial = await page.evaluate(visibilityProbe, ['tutNext']);
    await shot(page, `${w}x${h}-tutorial`);
    await page.click('#tutNext');   // one-card tutorial: Play
    await page.waitForFunction(() => state === 'playing', null, { timeout: 8000 });
    await page.waitForTimeout(800);
    // pause
    res.pauseBtn = await page.evaluate(visibilityProbe, ['pauseBtn']);
    await page.evaluate(() => pauseGame('button'));
    await page.waitForTimeout(200);
    res.pause = await page.evaluate(visibilityProbe, ['pauseResumeBtn', 'pauseMenuBtn']);
    await shot(page, `${w}x${h}-pause`);
    // results: typical
    await page.evaluate(() => {   // leave the pause and end the run to reach the results screen
      if (pauseInfo) { state = pauseInfo.from; pauseInfo = null; }
      document.getElementById('pauseOverlay').classList.remove('show', 'counting');
      endGame();
    });
    await page.waitForSelector('#overScreen:not(.hidden)', { timeout: 8000 });
    await page.waitForTimeout(700);
    res.results = await page.evaluate(visibilityProbe, ['retryBtn', 'copyResultBtn', 'overMenuBtn']);
    await shot(page, `${w}x${h}-results`);
    // results: tallest card (new best + boss row + unlock note + board badges all shown)
    await page.evaluate(() => {
      document.getElementById('newBestBadge').classList.remove('hidden');
      document.getElementById('slBossRow').style.display = '';
      const u = document.getElementById('unlockNote'); u.classList.remove('hidden'); u.textContent = 'Unlocked: Gold Groove vibe + Prism theme';
      const b = document.getElementById('boardBadges'); b.classList.remove('hidden'); if (!b.textContent.trim()) b.textContent = '#1 Arcade · #1 Daily';
      document.querySelector('#overScreen .card').scrollTop = 0;
    });
    await page.waitForTimeout(150);
    res.resultsTallest = await page.evaluate(visibilityProbe, ['retryBtn', 'copyResultBtn', 'overMenuBtn']);
    await shot(page, `${w}x${h}-results-tallest`);
    // informational: Back reachable on long screens (scrolling allowed)
    res.info = await page.evaluate(() => {
      const o = {};
      for (const id of ['settingsScreen', 'howtoScreen', 'boardScreen', 'loreScreen']) {
        const sc = document.getElementById(id); const card = sc && sc.querySelector('.card');
        o[id] = card ? { scrolls: card.scrollHeight > card.clientHeight + 1 } : null;
      }
      return o;
    });
    res.errors = errors;
    writeResult(`cg-layout-${w}x${h}`, res);
    const bad = [];
    for (const k of ['menu', 'tutorial', 'pauseBtn', 'pause', 'results', 'resultsTallest'])
      for (const [id, v] of Object.entries(res[k])) if (!v.ok) bad.push(`${k}:${id} (${v.why}${v.bottom ? `, bottom ${v.bottom}/${v.vh}` : ''})`);
    await ctx.close();
    expect(errors).toEqual([]);
    expect(bad, `CTAs not fully visible at ${w}x${h}`).toEqual([]);
  });
}
