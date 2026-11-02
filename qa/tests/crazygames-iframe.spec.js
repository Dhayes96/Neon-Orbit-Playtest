// CrazyGames Basic Launch (e): run the CrazyGames build inside an <iframe> on a DIFFERENT origin,
// the way a portal embeds a game: host page on https://portal.example.test, game on
// https://cdn.example.test (both served through Playwright routing, so no network and no
// local-network-access quirks). Two frames:
//   typical: allow="autoplay"
//   strict:  sandbox="allow-scripts allow-same-origin" (no popups, modals, clipboard permission)
// Checks: boots with no errors, audio starts from a click inside the frame, a run plays, the pause
// button works, clicking outside the game auto-pauses it (by design), the results screen's Copy
// Result degrades without crashing when prompt/clipboard are blocked, and every menu/results CTA
// is fully in view at all 10 required sizes inside the frame. Automated/simulated, not the real
// CrazyGames portal.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const path = require('path');
const { writeResult } = require('./harness');

const GAME = path.resolve(process.env.GAME_DIR || path.resolve(__dirname, '../..'));
const fs = require('fs');
const GAME_ORIGIN = 'https://cdn.example.test';
const GAME_URL = `${GAME_ORIGIN}/rhythm-void/index.html`;     // different origin from the host
const HOST_URL = 'https://portal.example.test/play.html';
const SIZES = [[907, 510], [1216, 684], [1077, 606], [821, 462], [1366, 768], [1920, 1080], [1536, 864], [1280, 720], [800, 450], [1080, 607]];
const FRAMES = {
  typical: 'allow="autoplay"',
  strict: 'sandbox="allow-scripts allow-same-origin" allow="autoplay"',
};

test.beforeAll(() => { execFileSync(process.execPath, [path.join(GAME, 'tools', 'build-crazygames.mjs')], { cwd: GAME }); });

async function openHost(page, attrs, w, h) {
  const gameHtml = fs.readFileSync(path.join(GAME, 'dist', 'crazygames', 'index.html'));
  await page.route(GAME_URL, (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: gameHtml }));
  await page.route(HOST_URL, (r) => r.fulfill({ contentType: 'text/html', body:
    `<!DOCTYPE html><html><body style="margin:0;background:#222"><button id="outside" style="position:fixed;right:0;bottom:0">outside</button>` +
    `<iframe id="game" src="${GAME_URL}" ${attrs} style="border:0;width:${w}px;height:${h}px;display:block"></iframe></body></html>` }));
  await page.addInitScript(() => { try { if (location.hostname === 'cdn.example.test') localStorage.setItem('rhythmVoidSave.v1', JSON.stringify({ tutorialDone: true, settings: { music: true, sfx: true } })); } catch {} });
  const errors = [], notes = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // Known + documented: when the portal frame doesn't grant clipboard-write, Chrome logs this
    // as the game tries the Clipboard API; the game then falls back (execCommand) and shows
    // "Copied". Recorded as a note, not a failure. Any other console error fails the test.
    if (/Permissions policy violation: The Clipboard API has been blocked/.test(m.text())) { notes.push('clipboard-permissions-policy notice'); return; }
    errors.push('console.error: ' + m.text());
  });
  await page.goto(HOST_URL);
  const frame = await (await page.waitForSelector('#game')).contentFrame();
  await frame.waitForFunction(() => typeof clockNow === 'function' && typeof state === 'string');
  return { frame, errors, notes };
}

function probe(ids) {
  const vw = innerWidth, vh = innerHeight, out = {};
  for (const id of ids) {
    const el = document.getElementById(id); if (!el) { out[id] = 'missing'; continue; }
    const r = el.getBoundingClientRect();
    let bad = (r.width === 0 || r.left < -0.5 || r.top < -0.5 || r.right > vw + 0.5 || r.bottom > vh + 0.5) ? 'outside' : '';
    for (let p = el.parentElement; p && !bad; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll|hidden|clip)/.test(cs.overflowY + cs.overflowX)) { const pr = p.getBoundingClientRect(); if (r.top < pr.top - 0.5 || r.bottom > pr.bottom + 0.5) bad = 'clipped'; }
    }
    if (!bad) { const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); if (!hit || !(hit === el || el.contains(hit))) bad = 'covered'; }
    out[id] = bad || 'ok';
  }
  return out;
}

for (const [kind, attrs] of Object.entries(FRAMES)) {
  test(`iframe (${kind}): boots, audio from a click, run + pause, outside click auto-pauses, results degrade safely`, async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 800 });
    const { frame, errors, notes } = await openHost(page, attrs, 1216, 684);
    const origin = await frame.evaluate(() => location.origin);
    await frame.click('#startBtn');
    await frame.waitForFunction(() => state === 'playing', null, { timeout: 8000 });
    const audioOk = await frame.waitForFunction(() => audioCtx && audioCtx.state === 'running', null, { timeout: 5000 }).then(() => true).catch(() => false);
    await frame.evaluate(() => { (function tick() { const t = clockNow() - startTime; for (const n of notes) if (!n.__t && t >= n.hitTime) { n.__t = 1; handleTap(null, true); break; } requestAnimationFrame(tick); })(); });
    await page.waitForTimeout(6000);
    const mid = await frame.evaluate(() => ({ state, hits: runStats.hits, misses: runStats.misses }));
    await frame.click('#pauseBtn');
    const pausedByButton = await frame.evaluate(() => state);
    await frame.click('#pauseResumeBtn');
    await frame.waitForFunction(() => state === 'playing', null, { timeout: 8000 });
    await page.waitForTimeout(1500);
    // click outside the game (portal chrome): the frame loses focus → auto-pause (by design)
    await page.click('#outside');
    await page.waitForTimeout(400);
    const afterOutside = await frame.evaluate(() => ({ state, reason: pauseInfo && pauseInfo.reason }));
    await frame.click('#pauseResumeBtn');
    await frame.waitForFunction(() => state === 'playing', null, { timeout: 8000 });
    // results + Copy Result (clipboard/prompt may be blocked in the strict frame)
    await frame.evaluate(() => endGame());
    await frame.waitForSelector('#overScreen:not(.hidden)', { timeout: 8000 });
    await frame.click('#copyResultBtn');
    await page.waitForTimeout(700);
    const copy = await frame.evaluate(() => ({ label: document.getElementById('copyResultBtn').textContent, state }));
    await frame.click('#overMenuBtn');
    const backAtMenu = await frame.evaluate(() => state);
    const res = { kind, attrs, origin, audioOk, mid, pausedByButton, afterOutside, copy, backAtMenu, errors, notes };
    writeResult(`cg-iframe-${kind}`, res);
    expect(errors).toEqual([]);
    expect(origin, 'game runs cross-origin from the host').toBe(GAME_ORIGIN);
    expect(audioOk, 'audio starts from a click inside the frame').toBe(true);
    expect(mid.hits).toBeGreaterThan(0);
    expect(pausedByButton).toBe('paused');
    expect(afterOutside).toEqual({ state: 'paused', reason: 'focus' });
    expect(['Copied ✓', 'Copy Failed', 'Copy Result']).toContain(copy.label.trim());
    expect(backAtMenu).toBe('menu');
  });
}

test('iframe (strict): every menu and results CTA fully in view at all 10 sizes inside the frame', async ({ page }) => {
  test.setTimeout(180_000);
  const out = {}, bad = [];
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w + 40, height: h + 40 });
    const { frame, errors } = await openHost(page, FRAMES.strict, w, h);
    const menu = await frame.evaluate(probe, ['startBtn', 'boardBtn', 'loreBtn', 'howtoBtn', 'settingsBtn']);
    await frame.evaluate(() => { save.tutorialDone = true; startGame(false); });
    await page.waitForTimeout(400);
    await frame.evaluate(() => endGame());
    await frame.waitForSelector('#overScreen:not(.hidden)', { timeout: 8000 });
    await page.waitForTimeout(500);
    const results = await frame.evaluate(probe, ['retryBtn', 'copyResultBtn', 'overMenuBtn']);
    out[`${w}x${h}`] = { menu, results, errors };
    for (const [k, v] of Object.entries({ ...menu, ...results })) if (v !== 'ok') bad.push(`${w}x${h} ${k}: ${v}`);
    for (const e of errors) bad.push(`${w}x${h} ${e}`);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    page.removeAllListeners('pageerror'); page.removeAllListeners('console');
  }
  writeResult('cg-iframe-sizes', out);
  expect(bad).toEqual([]);
});
