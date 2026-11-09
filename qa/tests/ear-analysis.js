// Ear-bot analyzer (test-only). Pure Node: no browser, no game code.
//
// Input: two mono recordings of the game's real rendered audio, captured
// sample-accurately in the page's own AudioContext (see ear-recorder.js):
//   tap   = the sfx bus (tap sounds only, before the master limiter)
//   music = the music bus (after the music limiter, before the master)
// plus the sequencer's scheduled step times (audio-clock seconds) from the
// harness probe, and the game's chord state logged at each tap.
//
// Output per run: raw distributions, not just pass/fail.
//   timing: tap-sound onset minus the nearest 1/16 step (ms, signed: + = late)
//   pitch : each tap sound's pitch classes vs (a) the key heard in the music
//           around it (Krumhansl key estimate on the music bus), (b) a semitone
//           clash with a strong note in the music at that moment, (c) the game's
//           own chord at that moment (exact, from game state), including a
//           semitone clash against it.
//   Known limit: the heard key (a) is noisy on sawtooth-heavy songs, whose
//   harmonics add notes that aren't in the chord (a sawtooth F adds an A), and on
//   songs that move between keys (Void Metal: Fm, G#m, Gm, A#m). So a tap fails
//   "fit" only if it is neither a chord tone nor in the heard key.
//
// What it can't see: device output latency, speaker/headphone delay, and how
// it feels to a human. Those are real-device checks (Dennel).

'use strict';

const PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// ---------- thresholds (the bot FAILS a run when these are crossed) ----------
const LIMITS = {
  timingMedianAbsMs: 15,   // |median signed offset| above this = systematically early/late
  timingP90AbsMs: 30,      // 90% of tap sounds must land within this of a 1/16 step
  fitShareMin: 0.85,       // share of taps whose notes are chord tones or all in the key heard around them
  clashShareMax: 0.15,     // share of taps a semitone against a strong music note (heard) or a chord tone (game chord)
};

// ---------- FFT (radix-2, in place) ----------
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

function spectrum(x, start, len, nfft) {
  const re = new Float64Array(nfft), im = new Float64Array(nfft);
  for (let i = 0; i < len; i++) {
    const s = x[start + i] || 0;
    re[i] = s * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (len - 1))); // Hann
  }
  fft(re, im);
  const mag = new Float64Array(nfft / 2);
  for (let i = 0; i < nfft / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
  return mag;
}

const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);
const mod12 = (v) => ((Math.round(v) % 12) + 12) % 12;

// ---------- tap onsets ----------
// An event starts when the 1 ms envelope rises above `floor` after >= 40 ms of
// quiet. The onset is refined to the first sample >= 2% of that event's peak
// (the game's tone() ramps exponentially over 6 ms, so 2% lands ~1.5 ms after
// the true start; the injected controls use the same tone() and show that bias).
function detectOnsets(x, sr, { floor = 0.0015, quietMs = 40 } = {}) {
  const win = Math.max(1, Math.round(sr / 1000));
  const env = [];
  for (let i = 0; i < x.length; i += win) {
    let m = 0; for (let j = i; j < Math.min(x.length, i + win); j++) m = Math.max(m, Math.abs(x[j]));
    env.push(m);
  }
  const out = [];
  let quiet = quietMs;
  for (let k = 0; k < env.length; k++) {
    if (env[k] < floor) { quiet++; continue; }
    if (quiet >= quietMs) {
      const s0 = Math.max(0, (k - 1) * win), s1 = Math.min(x.length, s0 + Math.round(0.03 * sr));
      let peak = 0; for (let j = s0; j < s1; j++) peak = Math.max(peak, Math.abs(x[j]));
      let on = s0; for (let j = s0; j < s1; j++) if (Math.abs(x[j]) >= 0.02 * peak) { on = j; break; }
      out.push({ sample: on, peak });
    }
    quiet = 0;
  }
  return out;
}

// ---------- pitch of one tap sound ----------
// Every spectral peak within 6 dB of the strongest one (60–2500 Hz) in the
// first 50 ms. Returns [] if the sound is noise-like (unpitched).
function tapPitches(x, sr, sample) {
  const len = Math.round(0.05 * sr), nfft = 16384;
  const mag = spectrum(x, sample, len, nfft);
  const binHz = sr / nfft, lo = Math.ceil(60 / binHz), hi = Math.floor(2500 / binHz);
  let max = 0; for (let i = lo; i <= hi; i++) max = Math.max(max, mag[i]);
  if (!max) return [];
  // spectral flatness over the band: noise-like sounds have no stable pitch
  let lg = 0, ar = 0, n = 0;
  for (let i = lo; i <= hi; i++) { lg += Math.log(mag[i] + 1e-12); ar += mag[i]; n++; }
  if (Math.exp(lg / n) / (ar / n) > 0.5) return [];
  const peaks = [];
  for (let i = lo + 1; i < hi; i++) {
    if (mag[i] < max * 0.5 || mag[i] < mag[i - 1] || mag[i] < mag[i + 1]) continue;
    const a = mag[i - 1], b = mag[i], c = mag[i + 1];
    const d = 0.5 * (a - c) / (a - 2 * b + c || 1e-12);         // parabolic interpolation
    const hz = (i + d) * binHz, midi = hzToMidi(hz);
    if (peaks.some((p) => Math.abs(p.midi - midi) < 0.5)) continue;
    peaks.push({ hz: +hz.toFixed(1), midi: +midi.toFixed(2), pc: mod12(midi), cents: Math.round((midi - Math.round(midi)) * 100), rel: +(b / max).toFixed(2) });
  }
  return peaks.sort((p, q) => q.rel - p.rel);
}

// ---------- music chroma + local key ----------
function chromaFrames(x, sr, { nfft = 8192, hop = 2048 } = {}) {
  const frames = [];
  // Band starts at 150 Hz: the game's kick is a sine sweep from 120-135 Hz down to
  // 38-44 Hz, passing A2 (110 Hz) and A1 (55 Hz) at full level. Below 150 Hz it made
  // every song read as A minor. Bass notes still count through their harmonics.
  const binHz = sr / nfft, lo = Math.ceil(150 / binHz), hi = Math.floor(2000 / binHz);
  const pcOfBin = new Int8Array(hi + 1);
  for (let i = lo; i <= hi; i++) pcOfBin[i] = mod12(hzToMidi(i * binHz));
  for (let s = 0; s + nfft <= x.length; s += hop) {
    const mag = spectrum(x, s, nfft, nfft);
    const c = new Float64Array(12);
    for (let i = lo; i <= hi; i++) c[pcOfBin[i]] += mag[i];
    frames.push({ t: (s + nfft / 2) / sr, c });
  }
  return frames;
}

function sumChroma(frames, t0, t1) {
  const c = new Float64Array(12);
  for (const f of frames) if (f.t >= t0 && f.t <= t1) for (let i = 0; i < 12; i++) c[i] += f.c[i];
  const m = Math.max(...c) || 1;
  return Array.from(c, (v) => v / m);
}

// Krumhansl–Kessler key profiles.
const KK_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const SCALE_MAJ = [0, 2, 4, 5, 7, 9, 11], SCALE_MIN = [0, 2, 3, 5, 7, 8, 10];
function corr(a, b) {
  const ma = a.reduce((s, v) => s + v, 0) / 12, mb = b.reduce((s, v) => s + v, 0) / 12;
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return n / Math.sqrt(da * db || 1e-12);
}
function estimateKey(chroma) {
  let best = { r: -2 };
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const [mode, prof] of [['major', KK_MAJ], ['minor', KK_MIN]]) {
      const rot = Array.from({ length: 12 }, (_, i) => prof[(i - tonic + 12) % 12]);
      const r = corr(chroma, rot);
      if (r > best.r) best = { r, tonic, mode };
    }
  }
  const scale = (best.mode === 'major' ? SCALE_MAJ : SCALE_MIN).map((i) => (i + best.tonic) % 12);
  return { name: PC_NAMES[best.tonic] + (best.mode === 'major' ? ' major' : ' minor'), tonic: best.tonic, mode: best.mode, r: +best.r.toFixed(2), scale };
}

// ---------- stats ----------
function pct(arr, p) { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; }
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
function dist(arr) {
  if (!arr.length) return { n: 0 };
  const abs = arr.map(Math.abs);
  return { n: arr.length, min: r1(Math.min(...arr)), p10: r1(pct(arr, 10)), p50: r1(pct(arr, 50)), p90: r1(pct(arr, 90)), max: r1(Math.max(...arr)),
    mean: r1(arr.reduce((a, b) => a + b, 0) / arr.length), absP50: r1(pct(abs, 50)), absP90: r1(pct(abs, 90)),
    histogram5ms: arr.reduce((h, v) => { const k = String(Math.round(v / 5) * 5); h[k] = (h[k] || 0) + 1; return h; }, {}) };
}

// ---------- main analysis ----------
// rec: { sr, startFrame, tap: Float32Array, music: Float32Array }
// steps: [{ w, step, bar }]  (audio-clock seconds, swing applied)
// tapLog: [{ ac, grade, voice, root, quality }]  (game state logged at each tap sound)
// botLog: [{ acHandler, targetW }]  (optional: when the bot's tap ran vs the step it aimed for)
function analyze({ rec, steps, tapLog = [], botLog = [], judgeGrades = ['perfect', 'good', 'ok'] }) {
  const { sr } = rec;
  const t0 = rec.startFrame / sr;
  const tEnd = t0 + rec.tap.length / sr;
  const grid = steps.map((s) => s.w).filter((w) => w >= t0 - 1 && w <= tEnd + 1).sort((a, b) => a - b);
  const nearest = (t) => { let b = null, bd = Infinity; for (const w of grid) { const d = Math.abs(t - w); if (d < bd) { bd = d; b = w; } } return b; };

  const musicChroma = chromaFrames(rec.music, sr);
  const shiftFrames = musicChroma.map((f) => ({ t: f.t + t0, c: f.c }));

  const onsets = detectOnsets(rec.tap, sr);
  const taps = [];
  let otherSfxIgnored = 0;
  for (const o of onsets) {
    const t = t0 + o.sample / sr;
    const w = nearest(t);
    let meta = null, md = 0.05;
    for (const m of tapLog) { const d = Math.abs(m.ac - t); if (d < md) { md = d; meta = m; } }
    // With a tap log, a sound on the sfx bus that no tap produced (level-up, tier
    // banner, UI blip) is not a tap sound: count it, don't judge it.
    if (tapLog.length && !meta) { otherSfxIgnored++; continue; }
    const pitches = tapPitches(rec.tap, sr, o.sample);
    const key = estimateKey(sumChroma(shiftFrames, t - 4, t + 1));
    const local = sumChroma(shiftFrames, t - 0.15, t + 0.15);
    const pcs = [...new Set(pitches.map((p) => p.pc))];
    const inKey = pcs.length ? pcs.every((pc) => key.scale.includes(pc)) : null;
    const clash = pcs.length ? pcs.some((pc) => local[pc] < 0.25 && (local[(pc + 1) % 12] >= 0.6 || local[(pc + 11) % 12] >= 0.6)) : null;
    let chordTones = null, chordFit = null, chordClash = null;
    if (meta && meta.root != null && meta.quality) {
      chordTones = meta.quality.map((i) => (meta.root + i) % 12);
      chordFit = pcs.length ? pcs.every((pc) => chordTones.includes(pc)) : null;
      // a semitone against a note of the chord the game is playing right now
      chordClash = pcs.length ? pcs.some((pc) => !chordTones.includes(pc) && chordTones.some((ct) => (pc - ct + 12) % 12 === 1 || (ct - pc + 12) % 12 === 1)) : null;
    }
    // A tap "fits" if its notes are chord tones, or (no chord known / not chord tones)
    // all in the key the music sounds like around it.
    const fits = pcs.length ? (chordFit === true || inKey === true) : null;
    let bot = null, bd = 0.08;
    for (const b of botLog) { const d = Math.abs(b.acHandler - t); if (d < bd) { bd = d; bot = b; } }
    taps.push({
      t: +t.toFixed(4), offsetMs: w == null ? null : r1((t - w) * 1000),
      grade: meta ? meta.grade : null, voice: meta ? meta.voice : null,
      pitches: pitches.map((p) => `${PC_NAMES[p.pc]}${Math.floor(Math.round(p.midi) / 12) - 1}${p.cents >= 0 ? '+' : ''}${p.cents}c (${p.hz} Hz)`),
      pcs: pcs.map((pc) => PC_NAMES[pc]),
      musicTopPcs: (() => { const c = sumChroma(shiftFrames, t - 1, t + 0.15); return c.map((v, i) => [i, v]).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([i, v]) => `${PC_NAMES[i]}:${v.toFixed(2)}`); })(),
      localKey: key.name, keyR: key.r, inKey, clash,
      gameChord: chordTones ? chordTones.map((pc) => PC_NAMES[pc]).join('-') : null, chordFit, chordClash, fits,
      botInputMs: bot ? r1((bot.acHandler - bot.targetW) * 1000) : null,
      soundAfterHandlerMs: bot ? r1((t - bot.acHandler) * 1000) : null,
    });
  }

  const judged = taps.filter((x) => !x.grade || judgeGrades.includes(x.grade));
  const offs = judged.map((x) => x.offsetMs).filter((v) => v != null);
  const pitched = judged.filter((x) => x.inKey != null);
  const share = (arr, f) => (arr.length ? +(arr.filter(f).length / arr.length).toFixed(3) : null);
  const timing = dist(offs);
  const pitch = {
    judgedTaps: judged.length, pitchedTaps: pitched.length,
    fitShare: share(pitched, (x) => x.fits),
    audioInKeyShare: share(pitched, (x) => x.inKey), audioClashShare: share(pitched, (x) => x.clash),
    gameChordToneShare: share(pitched.filter((x) => x.chordFit != null), (x) => x.chordFit),
    gameChordClashShare: share(pitched.filter((x) => x.chordClash != null), (x) => x.chordClash),
    pitchClassesHeard: pitched.reduce((h, x) => { const k = x.pcs.join('+'); h[k] = (h[k] || 0) + 1; return h; }, {}),
    localKeysHeard: pitched.reduce((h, x) => { h[x.localKey] = (h[x.localKey] || 0) + 1; return h; }, {}),
  };
  const timingFlag = timing.n ? (Math.abs(timing.p50) > LIMITS.timingMedianAbsMs || timing.absP90 > LIMITS.timingP90AbsMs) : null;
  const pitchFlag = pitched.length ? (pitch.fitShare < LIMITS.fitShareMin || pitch.audioClashShare > LIMITS.clashShareMax
    || (pitch.gameChordClashShare != null && pitch.gameChordClashShare > LIMITS.clashShareMax)) : null;
  const botIn = taps.map((x) => x.botInputMs).filter((v) => v != null);
  const sndLag = taps.map((x) => x.soundAfterHandlerMs).filter((v) => v != null);
  return {
    limits: LIMITS,
    recordedSeconds: +(rec.tap.length / sr).toFixed(1), sampleRate: sr,
    tapSoundsDetected: taps.length, tapLogEntries: tapLog.length, otherSfxIgnored,
    timingVsStepMs: timing, timingFlag,
    timingBreakdown: { botInputVsStepMs: dist(botIn), soundAfterTapHandlerMs: dist(sndLag) },
    pitch, pitchFlag,
    taps,
  };
}

module.exports = { analyze, detectOnsets, tapPitches, estimateKey, chromaFrames, sumChroma, LIMITS, PC_NAMES };
