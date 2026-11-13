// CrazyGames Basic Launch (b): the CrazyGames-only build (tools/build-crazygames.mjs).
// Acceptance (Jarvis's brief): 0 external network requests on load and through a full run;
// no googletagmanager / gtag( / playrhythmvoid.com / mailto: anywhere in the file; Shift+B and
// ?mapper=1 do nothing; Rename hidden; the live index.html is unchanged by the build; the ZIP
// holds index.html at the root and nothing else. Decision 4A: the CrazyGames build shows v1.0 on both
// version labels, while the live index.html keeps its own VERSION.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeResult } = require('./harness');

const GAME = path.resolve(process.env.GAME_DIR || path.resolve(__dirname, '../..'));
const OUT = path.join(GAME, 'dist', 'crazygames');
const URL_PATH = 'dist/crazygames/index.html';
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

let build = null;
test.beforeAll(() => {
  const before = sha(path.join(GAME, 'index.html'));
  const out = execFileSync(process.execPath, [path.join(GAME, 'tools', 'build-crazygames.mjs')], { cwd: GAME }).toString();
  build = { log: JSON.parse(out), liveBefore: before, liveAfter: sha(path.join(GAME, 'index.html')) };
});

function zipEntries(file) {
  const b = fs.readFileSync(file);
  const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = b.readUInt16LE(eocd + 10), cdOff = b.readUInt32LE(eocd + 16);
  const names = []; let p = cdOff;
  for (let i = 0; i < count; i++) { const nl = b.readUInt16LE(p + 28), el = b.readUInt16LE(p + 30), cl = b.readUInt16LE(p + 32); names.push(b.slice(p + 46, p + 46 + nl).toString()); p += 46 + nl + el + cl; }
  return names;
}

async function bootCG(page, query = '') {
  const external = [];
  page.on('request', (r) => { const u = r.url(); if (!/^(data:|blob:|about:)/.test(u) && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u)) external.push(u); });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  await page.addInitScript(() => {
    let a = 1234 >>> 0;
    Math.random = function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    localStorage.setItem('rhythmVoidSave.v1', JSON.stringify({ tutorialDone: true, settings: { music: true, sfx: true } }));
  });
  await page.goto(URL_PATH + query);
  await page.waitForFunction(() => typeof clockNow === 'function' && typeof state === 'string');
  return { external, errors };
}

test('CrazyGames build: file contents, ZIP and the live index.html are as required', async () => {
  const html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
  const banned = ['googletagmanager', 'gtag(', 'playrhythmvoid.com', 'mailto:'].filter((b) => html.includes(b));
  const zip = zipEntries(path.join(OUT, 'rhythm-void-crazygames.zip'));
  writeResult('cg-build-static', { build: build.log, bannedFound: banned, zipEntries: zip, liveUnchanged: build.liveBefore === build.liveAfter });
  expect(banned, 'banned strings in the CrazyGames file').toEqual([]);
  // index.html at the root, plus exactly the Project Zero media files when they exist (Nov 12)
  const pz = fs.existsSync(path.join(GAME, 'assets', 'project-zero')) ? fs.readdirSync(path.join(GAME, 'assets', 'project-zero')).filter((f) => /\.(mp4|m4a|jpg)$/.test(f)).sort().map((f) => 'assets/project-zero/' + f) : [];
  expect(zip, 'ZIP holds index.html (and the Project Zero media) only').toEqual(['index.html', ...pz]);
  expect(build.liveAfter, 'live index.html unchanged by the build').toBe(build.liveBefore);
  expect(html).toContain('id="renameBtn" hidden');
  expect(html).not.toContain('id="feedbackLink"');
  // Decision 4A: exactly one VERSION declaration, and it is v1.0; the live file keeps its own.
  const live = fs.readFileSync(path.join(GAME, 'index.html'), 'utf8');
  const cgDecls = html.match(/const VERSION = '[^']*';/g) || [];
  const liveDecls = live.match(/const VERSION = '[^']*';/g) || [];
  expect(cgDecls, 'CrazyGames VERSION declaration').toEqual(["const VERSION = 'v1.0';"]);
  expect(liveDecls.length, 'live VERSION declaration').toBe(1);
  expect(liveDecls[0], 'live VERSION is not changed by the build').not.toBe("const VERSION = 'v1.0';");
});

test('CrazyGames build: 0 external requests through load + a full run; share text has no link; dev tools and Rename unreachable', async ({ page }) => {
  const { external, errors } = await bootCG(page);
  // full run: start, autoplay a bit, end, results
  await page.click('#startBtn');
  await page.waitForFunction(() => state === 'playing' && audioCtx && audioCtx.state === 'running', null, { timeout: 8000 });
  await page.evaluate(() => { (function tick() { const t = clockNow() - startTime; for (const n of notes) if (!n.__t && t >= n.hitTime) { n.__t = 1; handleTap(null, true); break; } if (state === 'playing' || state === 'levelup' || state === 'bossBattle') requestAnimationFrame(tick); })(); });
  await page.waitForTimeout(12000);
  await page.evaluate(() => endGame());
  await page.waitForSelector('#overScreen:not(.hidden)', { timeout: 8000 });
  await page.click('#copyResultBtn');
  const share = await page.evaluate(() => lastShareText);
  // leaderboard: Rename hidden, Share Best text has no link
  await page.click('#overMenuBtn');
  await page.click('#boardBtn');
  const rename = await page.evaluate(() => { const b = document.getElementById('renameBtn'); return { hidden: b.hidden, display: getComputedStyle(b).display, rendered: b.getBoundingClientRect().width > 0 }; });
  const boardCopy = await page.evaluate(() => document.getElementById('boardSoon').textContent.trim());
  await page.click('#boardShareBtn');
  const shareBest = await page.evaluate(() => lastShareText);
  // Shift+B must not open the Beat Mapper
  await page.keyboard.press('Shift+KeyB');
  await page.waitForTimeout(300);
  const mapperAfterShiftB = await page.evaluate(() => ({ open: Mapper.open, shown: getComputedStyle(document.getElementById('mapperOverlay')).display !== 'none' }));
  // Decision 4A: what the player actually sees on the menu and in Settings.
  const labels = await page.evaluate(() => ({
    VERSION,
    menuTag: (document.querySelector('.version-tag') || {}).textContent,
    settings: (document.getElementById('settingsVersion') || {}).textContent,
  }));
  const res = { external, share, shareBest, rename, boardCopy, mapperAfterShiftB, labels, errors };
  writeResult('cg-build-runtime', res);
  expect(errors).toEqual([]);
  expect(external, 'external network requests').toEqual([]);
  expect(share).not.toMatch(/https?:\/\//);
  expect(shareBest).not.toMatch(/https?:\/\//);
  expect(rename.rendered, 'Rename hidden').toBe(false);
  expect(boardCopy).not.toMatch(/coming soon/i);
  expect(mapperAfterShiftB).toEqual({ open: false, shown: false });
  expect(labels, 'version labels (decision 4A)').toEqual({ VERSION: 'v1.0', menuTag: 'v1.0', settings: 'Rhythm Void v1.0' });
  expect(share, 'share text carries no old version').not.toContain('v0.');
});

test('CrazyGames build: ?mapper=1 does nothing', async ({ page }) => {
  const { external, errors } = await bootCG(page, '?mapper=1');
  await page.waitForTimeout(2500);
  const m = await page.evaluate(() => ({ open: Mapper.open, shown: getComputedStyle(document.getElementById('mapperOverlay')).display !== 'none' }));
  writeResult('cg-build-mapper-flag', { m, external, errors });
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
  expect(m).toEqual({ open: false, shown: false });
});
