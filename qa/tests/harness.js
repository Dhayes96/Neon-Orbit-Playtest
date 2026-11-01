// Shared QA harness: deterministic boot + in-page probes. The game is NOT
// modified; probes wrap global function declarations (spawnNote,
// scheduleStep) and read top-level let/const bindings via page.evaluate,
// which runs in the same global lexical scope as the game's classic script.
const fs = require('fs');
const path = require('path');

const SEED_SAVE = (overrides = {}) => ({
  level: 1, xp: 0, theme: 'cyberPink', difficulty: 'arcade', tutorialDone: true,
  settings: Object.assign({ music: true, musicVolume: 68, sfx: true, haptics: true, tapMode: 'target',
    musicVibe: 'cyberBounce', autoMatchVibe: false, environmentDetail: 'full', audioOffsetMs: 0,
    tapVoice: 'classic', tapVolume: 100 }, overrides.settings || {}),
  ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'settings')),
});

async function boot(page, { seed = 1234, save = {}, collect } = {}) {
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  // Analytics is external + nondeterministic: stub it (fulfil, don't abort, so no net error noise).
  await page.route(/googletagmanager|google-analytics/, (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await page.addInitScript(({ seed, save }) => {
    // Seam #1: seeded Math.random (mulberry32) so pattern choice is reproducible.
    let a = seed >>> 0;
    Math.random = function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    // Seam #2: pre-seeded save (skip tutorial, pick vibe).
    if (save) localStorage.setItem('rhythmVoidSave.v1', JSON.stringify(save));
    // Long-task observer for perf budgets.
    window.__longTasks = [];
    try { new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__longTasks.push({ start: e.startTime, dur: e.duration }))).observe({ type: 'longtask', buffered: true }); } catch {}
  }, { seed, save: SEED_SAVE(save) });
  await page.goto('index.html');
  await page.waitForFunction(() => typeof clockNow === 'function' && typeof state === 'string');
  return errors;
}

// Installs probes. Must run after the game script has executed.
async function installProbes(page) {
  await page.evaluate(() => {
    const qa = window.__qa = { steps: [], notes: [], taps: [], frames: [], wrapped: { step: 0, note: 0 } };
    const origStep = scheduleStep;
    window.scheduleStep = function (step, when, stepDur) {
      qa.wrapped.step++;
      const sw = (personalityProfile().swing) || 0;
      const w = (sw && step % 4 === 2) ? when + stepDur * sw : when;
      qa.steps.push({ step, when, w, stepDur, bpm, sw, phaseKey: music.phaseIndex, bar: music.bar, acNow: audioCtx.currentTime });
      return origStep.apply(this, arguments);
    };
    const origSpawn = spawnNote;
    window.spawnNote = function (hitTime, index) {
      qa.wrapped.note++;
      const ready = Conductor.ready();
      const nowG = clockNow() - startTime;
      qa.notes.push({ hitTime, index, stage, bpm, leadTime, ready, nowG,
        audio: ready ? Conductor.gameToAudio(hitTime) : null,
        conductorSwing: Conductor.swing(), trackSwing: personalityProfile().swing || 0,
        accents: (accentWeights() || []).slice(), phaseKey: music.phaseIndex });
      return origSpawn.apply(this, arguments);
    };
    // CROSS-REVIEW ADDITION: mark notes the game itself deletes (level-up / boss start / boss end clear `notes`)
    for (const fn of ['beginLevelPause', 'startBossEncounter', 'startDragonEncounter', 'defeatBoss', 'endBossEncounter', 'enterRealm', 'exitRealm',
      'pauseGame', 'resyncRunAfterInterruption']) {   // Phase 2: a pause clears rings with no penalty
      if (typeof window[fn] !== 'function') continue;
      const orig = window[fn];
      window[fn] = function () {
        for (const n of notes) if (!n.hit && !n.missed) { const q = qa.notes.find((x) => Math.abs(x.hitTime - n.hitTime) < 1e-9); if (q) q.cleared = fn; }
        return orig.apply(this, arguments);
      };
    }
    // Independent rAF frame sampler.
    let last = performance.now();
    (function f(ts) { qa.frames.push(ts - last); last = ts; requestAnimationFrame(f); })(performance.now());
  });
}

// In-page autoplayer: taps (keyboard path, timing only) the first frame at/after each hitTime.
// mode 'chart': taps at note.hitTime (what the game thinks is correct).
// mode 'ear'  : taps at the AUDIO step nearest the note, i.e. what a player
//               following the music would do. Divergence = audible desync.
async function startBot(page, { lateMs = 0, mode = 'chart' } = {}) {
  await page.evaluate(({ lateMs, mode }) => {
    const qa = window.__qa;
    function tick() {
      if (state === 'playing' || state === 'bossBattle') {
        const t = clockNow() - startTime;
        for (const n of notes) {
          if (n.hit || n.missed || n.__botTapped) continue;
          let target = n.hitTime;
          if (mode === 'ear' && Conductor.ready()) {
            const a = Conductor.gameToAudio(n.hitTime);
            if (n.__earT === undefined && audioCtx.currentTime > a - 0.12) {
              let best = null, bd = Infinity;
              for (const s of qa.steps) { const d = Math.abs(s.w - a); if (d < bd) { bd = d; best = s; } }
              n.__earT = best && bd < 0.15 ? Conductor.audioToGame(best.w) : n.hitTime;
            }
            if (n.__earT === undefined) continue;
            target = n.__earT;
          }
          if (t >= target + audioOffset() + lateMs / 1000) {
            n.__botTapped = true;
            const before = { p: runStats.perfects, g: runStats.goods, o: runStats.oks, m: runStats.misses };
            const tTap = clockNow() - startTime;
            handleTap(null, true);
            const res = runStats.perfects > before.p ? 'PERFECT' : runStats.goods > before.g ? 'GOOD' : runStats.oks > before.o ? 'OK' : runStats.misses > before.m ? 'MISS' : 'NONE';
            qa.taps.push({ errMs: (tTap - (n.hitTime + audioOffset())) * 1000, res, stage, bpm });
            break; // one tap per frame, like a human
          }
        }
      }
      if (!window.__botStop) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }, { lateMs, mode });
}

function pct(arr, p) { if (!arr.length) return NaN; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; }
function stats(arr) { return { n: arr.length, min: Math.min(...arr), p50: pct(arr, 50), p95: pct(arr, 95), p99: pct(arr, 99), max: Math.max(...arr), mean: arr.reduce((a, b) => a + b, 0) / (arr.length || 1) }; }
function writeResult(name, obj) {
  const dir = path.join(__dirname, '..', 'results'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(obj, null, 2));
}
module.exports = { boot, installProbes, startBot, stats, pct, writeResult };
