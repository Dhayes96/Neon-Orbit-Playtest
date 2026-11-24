// Beat sync: does every ring land on something you can HEAR in the music?
//
// A tap is in sync when the moment the ring asks for is the moment the music
// hits: a kick, a clap or snare, a bass note, an impact, a guitar chug. This
// test listens to the music the way the sequencer plays it: it wraps every
// voice the song calls while a step renders (kick, noise, synth, guitar,
// glide, impact), so it knows each sound's exact audio time, kind and
// loudness. Then it checks each ring's hit time against those sounds.
//
//   beat   a kick, clap/snare, bass, impact or chug sounds within 10 ms
//   thin   only a hat tick or a melody note sounds there
//   silent nothing audible starts there
//
// Dennel's rule (Nov 24 2026): "if the tap doesn't go along with the music,
// it's a fail". thin and silent both fail. Results per scenario go to
// results/beat-sync-<name>.json and a table in the log.
//
// It measures what the game schedules, before the speakers. Device latency
// and Bluetooth are out of scope here; the audio offset setting covers those.
//
//   npx playwright test tests/beat-sync.spec.js --project=beat-sync
//   BEAT_SYNC_ONLY=voidMetal npx playwright test tests/beat-sync.spec.js --project=beat-sync
const { test, expect } = require('@playwright/test');
const { boot, writeResult } = require('./harness');

const SECONDS = Number(process.env.BEAT_SYNC_SECONDS || 22);
const WIN = 0.010;                 // a ring and a hit within 10 ms are together
const STRONG = new Set(['kick', 'clap', 'bass', 'impact', 'riff']);
const UNLOCKS = { cubex: true, hexatron: true, triarch: true, vantaPrism: true, eclipseSovereign: true };

const VIBES = ['cyberBounce', 'bluePulse', 'toxicBreaks', 'goldGroove', 'darkWave', 'crimsonDrive', 'hellfire', 'voidMetal', 'cybermetal', 'ascension'];
const SCENARIOS = [];
for (const vibe of VIBES) for (const st of [2, 6, 12, 26]) SCENARIOS.push({ name: `${vibe}-s${st}`, vibe, stage: st });
for (const vibe of ['bluePulse', 'goldGroove', 'voidMetal']) for (const st of [3, 8]) SCENARIOS.push({ name: `chill-${vibe}-s${st}`, vibe, stage: st, diff: 'chill' });
for (const vibe of ['toxicBreaks', 'crimsonDrive', 'hellfire']) SCENARIOS.push({ name: `chaos-${vibe}-s12`, vibe, stage: 12, diff: 'chaos' });
for (const vibe of ['cyberBounce', 'voidMetal']) SCENARIOS.push({ name: `combo-${vibe}-s12`, vibe, stage: 12, combo: 80 });
for (const vibe of ['cyberBounce', 'voidMetal']) for (const st of [10, 20, 30, 40, 50, 70, 100]) SCENARIOS.push({ name: `boss${st}-${vibe}`, vibe, stage: st, boss: true });
for (const key of ['abyss', 'planet', 'architect']) SCENARIOS.push({ name: `secret-${key}`, vibe: 'cyberBounce', secret: key });

const ONLY = process.env.BEAT_SYNC_ONLY;

function installEars() {
  const E = window.__ears = { on: [], notes: [], inStep: 0, pat: '' };
  const wrap = (name, kindOf) => {
    const o = window[name];
    if (typeof o !== 'function') return;
    window[name] = function (...a) {
      if (E.inStep) { try { const r = kindOf(a); if (r && isFinite(r.t)) E.on.push(r); } catch (e) {} }
      return o.apply(this, a);
    };
  };
  const os = window.scheduleStep;
  window.scheduleStep = function () { E.inStep++; try { return os.apply(this, arguments); } finally { E.inStep--; } };
  wrap('kickVoice', (a) => ({ t: a[0], k: 'kick', g: (a[1] == null ? 0.16 : a[1]) * (a[3] == null ? 1 : a[3]) }));
  wrap('impactVoice', (a) => ({ t: a[0], k: 'impact', g: 0.2 * (a[1] == null ? 1 : a[1]) }));
  wrap('noiseVoice', (a) => {
    const [t, dur, g, ft, f, , bg = 1] = a;
    const k = ft === 'highpass' ? 'hat' : (f <= 3200 && dur >= 0.06 ? 'clap' : 'noise');
    return { t, k, g: g * bg, f, dur };
  });
  wrap('synthVoice', (a) => {
    const [t, f, dur, o = {}] = a;
    if ((o.attack == null ? 0.005 : o.attack) >= 0.12) return null;            // pads swell in: not an onset
    return { t, k: f <= 200 ? 'bass' : 'tone', g: (o.gain == null ? 0.05 : o.gain) * (o.busGain == null ? 1 : o.busGain), f, dur };
  });
  wrap('guitarVoice', (a) => {
    const [t, f, , o = {}] = a;
    return { t, k: f <= 260 ? 'riff' : 'lead', g: (o.gain == null ? 0.05 : o.gain) * (o.busGain == null ? 1 : o.busGain), f };
  });
  wrap('glideVoice', (a) => {
    const [t, f0, , , o = {}] = a;
    if ((o.attack == null ? 0.02 : o.attack) >= 0.12) return null;
    return { t, k: f0 <= 200 ? 'bass' : 'tone', g: (o.gain == null ? 0.03 : o.gain) * (o.busGain == null ? 1 : o.busGain), f: f0 };
  });
  const oc = window.chooseRhythmPattern;
  window.chooseRhythmPattern = function () { const p = oc.apply(this, arguments); E.pat = (p && p.name) || '?'; E.offsets = p && p.offsets; return p; };
  const osp = window.spawnNote;
  window.spawnNote = function (hitTime) {
    const ready = Conductor.ready();
    E.notes.push({
      hit: hitTime, a: ready ? Conductor.gameToAudio(hitTime) : null, ready,
      step: ready ? Conductor.stepAt(hitTime) : null, sd: ready ? Conductor.stepDur() : null,
      stage, bpm, pat: E.pat, boss: (bossActive && activeBoss) ? activeBoss.id : null,
      beatMap: BeatMap.active(), phase: music.phaseIndex, swing: Conductor.swing(),
    });
    return osp.apply(this, arguments);
  };
}

async function drive(page, sc) {
  const save = { level: 90, flightDone: true, bossUnlocks: UNLOCKS, difficulty: sc.diff || 'arcade',
    settings: { musicVibe: sc.vibe, autoMatchVibe: false, lowGraphics: true } };
  const errors = await boot(page, { save });
  await page.evaluate(installEars);
  if (sc.secret) {
    await page.evaluate((key) => {
      setInterval(() => { if (energy < 60) energy = 100; }, 50);
      startSecretGauntlet(key);
      stage = doomStagesTotal() + 1; bpm = stageBpmTarget();
      requestAnimationFrame(() => { if (state === 'playing') startDragonEncounter(); });
    }, sc.secret);
    await page.waitForFunction(() => state === 'bossBattle', null, { timeout: 20000 });
  } else {
    await page.evaluate(() => startGame(false));
    await page.waitForFunction(() => state === 'playing');
    await page.waitForFunction(() => audioCtx && audioCtx.state === 'running' && music.on, null, { timeout: 8000 });
    await page.evaluate((sc) => {
      setInterval(() => { if (energy < 60) energy = 100; if (sc.combo) combo = Math.max(combo, sc.combo); }, 50);
      if (sc.stage > 1) { hitsTotal = stageHitsNeeded(sc.stage, diff); stageUp(sc.stage); }
    }, sc);
    if (sc.boss) await page.waitForFunction(() => state === 'bossBattle', null, { timeout: 30000 });
  }
  // let the level-up pause, the boss entrance and the music crossfade settle
  await page.waitForTimeout(4000);
  await page.evaluate(() => { window.__ears.on.length = 0; window.__ears.notes.length = 0; window.__ears.t0 = audioCtx.currentTime; });
  await page.waitForTimeout(SECONDS * 1000);
  const r = await page.evaluate(() => ({ on: window.__ears.on, notes: window.__ears.notes, t0: window.__ears.t0, t1: audioCtx.currentTime, state }));
  return { errors, ...r };
}

function judge(r) {
  const on = r.on.slice().sort((x, y) => x.t - y.t);
  const kicks = on.filter((o) => o.k === 'kick').map((o) => o.g).sort((a, b) => a - b);
  const strongs = on.filter((o) => STRONG.has(o.k)).map((o) => o.g).sort((a, b) => a - b);
  const ref = (kicks.length ? kicks : strongs)[Math.floor(((kicks.length ? kicks : strongs).length - 1) * 0.5)] || 0.1;
  const lastSound = on.length ? on[on.length - 1].t : r.t1;
  const out = { notes: 0, beat: 0, thin: 0, silent: 0, notReady: 0, byPattern: {}, fails: [] };
  for (const n of r.notes) {
    if (!n.ready) { out.notReady++; continue; }
    if (n.a < r.t0 + 0.05 || n.a > lastSound - 0.05) continue;   // only rings whose moment the recording covers
    out.notes++;
    const near = on.filter((o) => Math.abs(o.t - n.a) <= WIN);
    const strong = near.filter((o) => STRONG.has(o.k) && o.g >= ref * 0.12);
    const audible = near.filter((o) => o.g >= ref * 0.02);
    const v = strong.length ? 'beat' : audible.length ? 'thin' : 'silent';
    out[v]++;
    const key = (n.boss ? n.boss + ':' : '') + n.pat;
    const p = out.byPattern[key] || (out.byPattern[key] = { notes: 0, fail: 0 });
    p.notes++;
    if (v !== 'beat') {
      p.fail++;
      const s16 = n.step, frac = s16 - Math.round(s16);
      const nearest = on.reduce((b, o) => (STRONG.has(o.k) && o.g >= ref * 0.12 && (!b || Math.abs(o.t - n.a) < Math.abs(b.t - n.a))) ? o : b, null);
      if (out.fails.length < 40) out.fails.push({ v, pat: key, stage: n.stage, step16: Math.round(((s16 % 16) + 16) % 16 * 100) / 100,
        offGridMs: Math.round(frac * n.sd * 1000), heard: near.map((o) => o.k + '@' + Math.round((o.t - n.a) * 1000) + 'ms'),
        nearestBeatMs: nearest ? Math.round((nearest.t - n.a) * 1000) : null, bpm: Math.round(n.bpm) });
    }
  }
  out.failRate = out.notes ? Math.round((out.thin + out.silent) / out.notes * 1000) / 10 : null;
  return out;
}

const rows = [];
for (const sc of SCENARIOS) {
  if (ONLY && !sc.name.includes(ONLY)) continue;
  test(`beat sync: ${sc.name}`, async ({ page }) => {
    test.setTimeout(120000);
    const r = await drive(page, sc);
    const j = judge(r);
    writeResult(`beat-sync-${sc.name}`, { scenario: sc, endState: r.state, ...j });
    const line = `BEATSYNC ${sc.name.padEnd(24)} rings ${String(j.notes).padStart(3)}  beat ${String(j.beat).padStart(3)}  thin ${String(j.thin).padStart(3)}  silent ${String(j.silent).padStart(3)}  fail ${j.failRate}%`;
    console.log(line);
    for (const f of j.fails.slice(0, 12)) console.log('BEATSYNC   ' + JSON.stringify(f));
    rows.push(line);
    expect.soft(j.notes, 'rings were measured').toBeGreaterThan(4);
    expect.soft(j.thin + j.silent, `${sc.name}: every ring lands on a beat you can hear`).toBe(0);
  });
}
