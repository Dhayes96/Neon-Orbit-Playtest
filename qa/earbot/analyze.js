// Ear-bot (listening), analysis side. Pure Node, no dependencies.
//
// Input: three recorded stems of the game's real audio (music, taps, mix) on the
// AudioContext timeline, plus the in-page logs (bot presses, tap-voice calls,
// what the sequencer scheduled). Output: per-tap numbers, per-song summaries,
// self-checks, and PASS / FAIL / UNRELIABLE verdicts.
//
// Everything that decides a verdict is measured from the audio:
//   - tap attack time      : from the taps stem
//   - where the beat sounds : the music stem's drum attacks (kick onsets)
//   - the chord sounding   : chroma of the music stem, per bar
//   - the tap's notes      : spectral peaks of the taps stem
// The sequencer logs are used to find bars and steps (where to look) and as
// ground truth to CHECK the listening (chord agreement, drum alignment). They
// never decide a verdict on their own.

'use strict';

// ---------------- thresholds (fixed before any song was measured) ----------------
const TH = {
  timingMedianMs: 10,   // |median| tap attack vs the beat's drum attack
  timingP90Ms: 20,      // 90% of taps within this (flams become audible ~20-30 ms)
  sourShare: 0.5,       // a tap is "sour" if >= half its pitched energy rubs the chord
  sourTapsMax: 0.15,    // FAIL if more than 15% of a voice's taps are sour
  chordAgreeMin: 0.8,   // listening must agree with the sequencer on >= 80% of bars
  kickSpreadMaxMs: 2,   // drum alignment self-check (p90 - p10 of kick attack offset)
  tapMatchMin: 0.9,     // >= 90% of sounded taps must be found in the audio
  gapMaxShare: 0.01,    // skipped frames must stay under 1% of the recording
  flamMs: 30,           // "audibly off" line used in the human-jitter report
  botStallMs: 25,       // a press this much later than the bot meant is a harness stall: excluded, counted
};

const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const CHORD = { min: [0, 3, 7], maj: [0, 4, 7] };
// Notes that rub a semitone against a chord tone AND are outside the chord's
// natural scale (minor: aeolian; major: ionian + b7). Music theory's "avoid notes".
const SOUR = { min: new Set([1, 4, 6, 11]), maj: new Set([1, 3, 6, 8]) };
// Krumhansl-Kessler key profiles (major, minor).
const KK = {
  maj: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
  min: [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
};
const SCALE = { maj: [0, 2, 4, 5, 7, 9, 11], min: [0, 2, 3, 5, 7, 8, 10] };

// ---------------- small DSP kit ----------------
function fftPow(re) {                 // power spectrum of a real signal (length = power of 2)
  const n = re.length, im = new Float64Array(n), x = Float64Array.from(re);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { const t = x[i]; x[i] = x[j]; x[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = x[b] * cr - im[b] * ci, ti = x[b] * ci + im[b] * cr;
        x[b] = x[a] - tr; im[b] = im[a] - ti; x[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  const out = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) out[k] = x[k] * x[k] + im[k] * im[k];
  return out;
}
const hann = (n) => Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)));
const tukey = (n, a = 0.2) => Float64Array.from({ length: n }, (_, i) => {
  const e = a * (n - 1) / 2;
  if (i < e) return 0.5 * (1 + Math.cos(Math.PI * (i / e - 1)));
  if (i > n - 1 - e) return 0.5 * (1 + Math.cos(Math.PI * ((i - n + 1) / e + 1)));
  return 1;
});
function rmsEnv(x, win = 32) {        // centred moving RMS
  const c = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) c[i + 1] = c[i] + x[i] * x[i];
  const e = new Float32Array(x.length), h = win >> 1;
  for (let i = 0; i < x.length; i++) {
    const a = Math.max(0, i - h), b = Math.min(x.length, i + h);
    e[i] = Math.sqrt((c[b] - c[a]) / Math.max(1, b - a));
  }
  return e;
}
function median(a) { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function pct(a, p) { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(p / 100 * (s.length - 1))))]; }
const r1 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);

// One attack rule for every sound: the first crossing of
// baseline + 30% of (peak - baseline), where the baseline is the envelope just
// before the event and the peak is the loudest point in the search window.
function attackAt(env, i0, i1, baseFrom, baseTo) {
  if (i0 < 0 || i1 > env.length || i1 <= i0) return null;
  const b = [];
  for (let i = Math.max(0, baseFrom); i < Math.max(0, baseTo); i++) b.push(env[i]);
  const base = b.length ? median(b) : 0;
  let pk = 0, pi = i0;
  for (let i = i0; i < i1; i++) if (env[i] > pk) { pk = env[i]; pi = i; }
  if (pk - base < 1e-4 || pk < base * 1.5) return null;     // nothing rose here
  const thr = base + 0.3 * (pk - base);
  for (let i = i0; i <= pi; i++) if (env[i] >= thr) {
    const a = env[i - 1];                                    // sub-sample interpolation, only on a real rise
    if (i === i0 || a === undefined || !(a < thr) || !(env[i] > a)) return i;
    return i - 1 + (thr - a) / (env[i] - a);
  }
  return null;
}

// Chroma from spectral peaks (55-2000 Hz), magnitude-weighted, max-normalised.
function chroma(x, sr) {
  const N = 8192, hop = 2048, w = hann(N), C = new Float64Array(12);
  const binPc = new Int8Array(N / 2 + 1).fill(-1);
  for (let k = 1; k <= N / 2; k++) { const f = k * sr / N; if (f >= 55 && f <= 2000) binPc[k] = ((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12; }
  const buf = new Float64Array(N);
  for (let s = 0; s + N <= x.length; s += hop) {
    for (let i = 0; i < N; i++) buf[i] = x[s + i] * w[i];
    const P = fftPow(buf);
    for (let k = 1; k < N / 2; k++) if (binPc[k] >= 0 && P[k] > P[k - 1] && P[k] >= P[k + 1]) C[binPc[k]] += Math.sqrt(P[k]);
  }
  const mx = Math.max(...C) || 1;
  return Array.from(C, (v) => v / mx);
}
function bestChord(C) {
  let best = null;
  const nC = Math.hypot(...C) || 1;
  for (let r = 0; r < 12; r++) for (const q of ['min', 'maj']) {
    let dot = 0; for (const iv of CHORD[q]) dot += C[(r + iv) % 12];
    const s = dot / (Math.sqrt(3) * nC);
    if (!best || s > best.score) best = { root: r, q, score: s };
  }
  return best;
}
function bestKey(C) {
  let best = null;
  for (let r = 0; r < 12; r++) for (const q of ['maj', 'min']) {
    const p = KK[q], pm = p.reduce((a, b) => a + b) / 12, cm = C.reduce((a, b) => a + b) / 12;
    let num = 0, dp = 0, dc = 0;
    for (let i = 0; i < 12; i++) { const a = p[(i - r + 12) % 12] - pm, b = C[i] - cm; num += a * b; dp += a * a; dc += b * b; }
    const s = num / Math.sqrt(dp * dc || 1);
    if (!best || s > best.score) best = { root: r, q, score: s };
  }
  return best;
}
// Prominent spectral peaks of a short tap: [{hz, midi, share}], noise ignored.
function tapNotes(seg, sr) {
  const N = 16384, buf = new Float64Array(N), w = tukey(seg.length, 0.2);
  for (let i = 0; i < seg.length && i < N; i++) buf[i] = seg[i] * w[i];
  const P = fftPow(buf);
  let mx = 0; for (const v of P) if (v > mx) mx = v;
  const peaks = [];
  for (let k = 3; k < P.length - 3; k++) {
    const f = k * sr / N;
    // Below 100 Hz a ~0.1 s tap can't resolve a pitch class (a semitone there is
    // < 6 Hz) and phone speakers barely play it, so sub-bass thumps aren't judged.
    if (f < 100 || f > 6000 || P[k] < mx * 1e-3 || !(P[k] > P[k - 1] && P[k] >= P[k + 1])) continue;
    // Tonal = towers over its +-400 Hz neighbourhood. A short tap has a wide main
    // lobe, so a narrow neighbourhood would reject real notes; noise bursts have no
    // peak that stands this far out.
    const nb = []; for (let j = Math.max(0, k - 150); j < Math.min(P.length, k + 150); j++) nb.push(P[j]);
    if (P[k] / (median(nb) + 1e-30) < 10) continue;
    const a = Math.log(P[k - 1] + 1e-30), b = Math.log(P[k] + 1e-30), c = Math.log(P[k + 1] + 1e-30);
    const fk = (k + 0.5 * (a - c) / (a - 2 * b + c)) * sr / N;
    // Only a NAMEABLE pitch counts: a peak smeared over more than half an octave
    // (-6 dB width > 6 semitones) is a pitch glide, like the Kick's 144 -> 65 Hz
    // thump, not a note. Measured widths: real tap notes 1-4 semitones, the Kick
    // glide 12-22.
    let lo = k, hi = k;
    while (lo > 1 && P[lo] > P[k] / 4) lo--;
    while (hi < P.length - 2 && P[hi] > P[k] / 4) hi++;
    const wHz = (hi - lo) * sr / N;
    if (fk - wHz / 2 <= 0 || 12 * Math.log2((fk + wHz / 2) / (fk - wHz / 2)) > 6) continue;
    let e = 0; for (let j = k - 3; j <= k + 3; j++) e += P[j];
    peaks.push({ hz: fk, midi: 69 + 12 * Math.log2(fk / 440), e });
  }
  const tot = peaks.reduce((s, p) => s + p.e, 0) || 1;
  return peaks.map((p) => ({ hz: p.hz, midi: p.midi, share: p.e / tot })).sort((x, y) => y.share - x.share);
}
// A second attack inside one tap sound (e.g. a two-note voice): ms after the first, or null.
function secondAttack(env, a, sr) {
  const ms = (x) => Math.round(x * sr / 1000);
  let p1 = 0; for (let i = a; i < a + ms(12) && i < env.length; i++) p1 = Math.max(p1, env[i]);
  let mn = Infinity;
  for (let i = a + ms(12); i < a + ms(80) && i < env.length; i++) {
    mn = Math.min(mn, env[i]);
    if (env[i] > 0.4 * p1 && env[i] > 2 * mn) {
      const z = attackAt(env, i - ms(4), i + ms(10), i - ms(4), i - ms(3));
      return ((z != null ? z : i) - a) * 1000 / sr;
    }
  }
  return null;
}
const rmsOf = (x, a, b) => { let s = 0, n = 0; for (let i = Math.max(0, a); i < Math.min(x.length, b); i++) { s += x[i] * x[i]; n++; } return Math.sqrt(s / Math.max(1, n)); };
const noteName = (m) => NOTE[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1);
const chordName = (c) => (c ? NOTE[c.root] + (c.q === 'min' ? 'm' : '') : '?');

// ---------------- main analysis ----------------
function analyze({ meta, stems, assemble, label = '' }) {
  const sr = meta.sampleRate, f0 = assemble.startFrame;
  const T = (t) => Math.round(t * sr) - f0;                 // context seconds -> stem index
  const S = (i) => (i + f0) / sr;                           // stem index -> context seconds
  const ms = (s) => Math.round(s * sr / 1000);              // ms -> samples
  const music = stems.music, taps = stems.taps;
  const eM = rmsEnv(music), eT = rmsEnv(taps);
  const dur = music.length / sr;
  const gapFrames = (assemble.gaps || []).reduce((s, g) => s + g.frames, 0);
  const gapAt = (t) => (assemble.gaps || []).some((g) => { const a = g.fromFrame / sr, b = a + g.frames / sr; return t > a - 0.3 && t < b + 0.3; });

  const sched = meta.sched || [];
  // ---- 1. where the beat actually sounds: kick attacks vs their scheduled time ----
  const kick = [];
  for (const s of sched) {
    if (!s.kick || s.xfade || !s.continuous) continue;
    const i = T(s.w);
    const a = attackAt(eM, i - ms(3), i + ms(60), i - ms(45), i - ms(8));
    if (a != null && !gapAt(s.w)) kick.push((S(a) - s.w) * 1000);
  }
  const kickAttackMs = median(kick);
  const kickSpreadMs = pct(kick, 90) - pct(kick, 10);

  // ---- 2. bars: the chord the music plays, heard from the music stem ----
  const bars0 = sched.filter((s) => s.step === 0);
  const bars = [];
  for (let i = 0; i + 1 < bars0.length; i++) {
    const b = bars0[i], e = bars0[i + 1];
    const a = T(b.w + 0.02), z = T(e.w - 0.01);
    if (a < 0 || z > music.length || z - a < 8192) continue;
    const C = chroma(music.subarray(a, z), sr);
    const est = bestChord(C);
    const truth = { root: ((b.root % 12) + 12) % 12, q: b.quality === '0,4,7' ? 'maj' : 'min' };
    bars.push({ from: b.w, to: e.w, phase: b.phase, est, truth, chroma: C.map(r2),
      agree: est.root === truth.root && est.q === truth.q, xfade: b.xfade, boss: b.boss > 0.02 });
  }
  const barsChecked = bars.filter((b) => !b.xfade && !b.boss);
  const chordAgree = barsChecked.length ? barsChecked.filter((b) => b.agree).length / barsChecked.length : NaN;
  // Key of each passage (phase), from the music's chroma summed over its bars.
  const keys = {};
  for (const b of bars) { (keys[b.phase] = keys[b.phase] || new Array(12).fill(0)); b.chroma.forEach((v, i) => { keys[b.phase][i] += v; }); }
  const phaseKey = {};
  for (const [ph, C] of Object.entries(keys)) phaseKey[ph] = bestKey(C);

  // ---- 3. every bot press: find its tap sound in the taps stem, time it, hear its notes ----
  const rows = [];
  let sounded = 0, found = 0;
  for (const bt of meta.botTaps || []) {
    const tv = bt.tapIdx >= 0 ? meta.taps[bt.tapIdx] : null;
    if (!tv || !tv.sounded) continue;                       // voice 'off', or no sound requested
    sounded++;
    if (gapAt(bt.ctxAt)) continue;
    // The beat this note sits on: the scheduled step nearest the note's hit time.
    let step = null, bd = Infinity;
    for (const s of sched) { const d = Math.abs(s.w - bt.hitAudio); if (d < bd) { bd = d; step = s; } }
    if (!step || bd > 0.03) continue;
    const i = T(bt.ctxAt);
    const a = attackAt(eT, i - ms(5), i + ms(250), i - ms(40), i - ms(6));
    if (a == null) continue;
    found++;
    const tapT = S(a);
    const beatT = step.w + (isFinite(kickAttackMs) ? kickAttackMs / 1000 : 0);  // where the drums' attack lands
    const notesHeard = tapNotes(taps.subarray(Math.max(0, a - ms(2)), a + ms(100)), sr);
    const bar = bars.find((b) => tapT >= b.from && tapT < b.to);
    const cat = (c, m) => { const iv = (((Math.round(m) - c.root) % 12) + 12) % 12; return CHORD[c.q].includes(iv) ? 'chord' : SOUR[c.q].has(iv) ? 'sour' : 'color'; };
    const shares = (c) => { const o = { chord: 0, color: 0, sour: 0 }; if (!c) return null; for (const p of notesHeard) o[cat(c, p.midi)] += p.share; return o; };
    const sh = bar ? shares(bar.est) : null, shTruth = bar ? shares(bar.truth) : null;
    const key = bar ? phaseKey[bar.phase] : null;
    const inKey = key ? notesHeard.reduce((s, p) => s + (SCALE[key.q].includes((((Math.round(p.midi) - key.root) % 12) + 12) % 12) ? p.share : 0), 0) : null;
    rows.push({
      voice: bt.voice, grade: bt.res, stage: bt.stage, bpm: bt.bpm,
      pressVsBeatMs: r1((bt.ctxAt - step.w) * 1000),           // the bot's own timing (exact bot: clock granularity)
      pressToSoundMs: r1((tapT - bt.ctxAt) * 1000),            // the game's tap -> sound path, incl. attack
      tapVsBeatMs: r1((tapT - beatT) * 1000),                  // THE timing number: tap attack vs drum attack
      tapVsGridMs: r1((tapT - step.w) * 1000),
      chordHeard: bar ? chordName(bar.est) : null, chordSeq: bar ? chordName(bar.truth) : null,
      gameRootMatches: bar ? (((tv.gameRoot % 12) + 12) % 12) === bar.est.root : null,   // liveChordRoot() vs the chord heard
      notes: notesHeard.filter((p) => p.share >= 0.05).slice(0, 4).map((p) => `${noteName(p.midi)}:${r2(p.share)}`).join(' '),
      chordShare: sh ? r2(sh.chord) : null, colorShare: sh ? r2(sh.color) : null, sourShare: sh ? r2(sh.sour) : null,
      sour: sh ? sh.sour >= TH.sourShare : null, sourBySequencerChord: shTruth ? shTruth.sour >= TH.sourShare : null,
      keyHeard: key ? NOTE[key.root] + (key.q === 'min' ? 'm' : '') : null, inKeyShare: r2(inKey),
      jitterMs: r1(bt.jitterMs),
      secondAttackMs: r1(secondAttack(eT, Math.round(a), sr)),
      tapVsMusicDb: r1(20 * Math.log10((rmsOf(taps, Math.round(a), Math.round(a) + ms(60)) + 1e-9) / (rmsOf(music, Math.round(a), Math.round(a) + ms(60)) + 1e-9))),
      botStall: (bt.ctxAt - step.w) * 1000 - (bt.jitterMs || 0) > TH.botStallMs,
    });
  }

  // ---- 4. summaries + verdicts ----
  const reliability = {
    gapMs: r1(gapFrames / sr * 1000), gapShare: r2(gapFrames / sr / dur), staleQuanta: assemble.staleQuanta || 0,
    kickAttackMs: r1(kickAttackMs), kickSpreadMs: r2(kickSpreadMs), kicksMeasured: kick.length,
    barsChecked: barsChecked.length, chordAgree: r2(chordAgree),
    tapsSounded: sounded, tapsFound: found, tapMatch: r2(sounded ? found / sounded : NaN),
  };
  const capOk = reliability.gapShare <= TH.gapMaxShare && kick.length >= 8 && kickSpreadMs <= TH.kickSpreadMaxMs;
  const timingReliable = capOk && (sounded ? found / sounded : 0) >= TH.tapMatchMin;
  const pitchReliable = timingReliable && barsChecked.length >= 4 && chordAgree >= TH.chordAgreeMin;

  const human = rows.some((r) => r.jitterMs);
  const summarise = (R0) => {
    const R = R0.filter((r) => !r.botStall);                 // pitch and timing use on-time presses only
    const off = R.map((r) => r.tapVsBeatMs), abs = off.map(Math.abs);
    const withBar = R.filter((r) => r.sour !== null);
    const sourN = withBar.filter((r) => r.sour).length;
    const perfect = R.filter((r) => r.grade === 'PERFECT');
    return {
      n: R.length, botStalls: R0.length - R.length,
      tapVsBeatMs: { median: r1(median(off)), p10: r1(pct(off, 10)), p90: r1(pct(off, 90)), absP90: r1(pct(abs, 90)), min: r1(Math.min(...off)), max: r1(Math.max(...off)) },
      pressToSoundMs: { median: r1(median(R.map((r) => r.pressToSoundMs))), p90: r1(pct(R.map((r) => r.pressToSoundMs), 90)) },
      pressVsBeatMs: { median: r1(median(R.map((r) => r.pressVsBeatMs))), p90: r1(pct(R.map((r) => r.pressVsBeatMs), 90)) },
      perfectOffBeyondFlamMs: perfect.length ? r2(perfect.filter((r) => Math.abs(r.tapVsBeatMs) > TH.flamMs).length / perfect.length) : null,
      nPitch: withBar.length, sourTaps: sourN, sourRate: withBar.length ? r2(sourN / withBar.length) : null,
      sourRateBySequencerChord: withBar.length ? r2(withBar.filter((r) => r.sourBySequencerChord).length / withBar.length) : null,
      chordShareMean: r2(withBar.reduce((s, r) => s + r.chordShare, 0) / (withBar.length || 1)),
      inKeyShareMean: r2(withBar.reduce((s, r) => s + (r.inKeyShare || 0), 0) / (withBar.length || 1)),
      gameRootMismatch: withBar.filter((r) => r.gameRootMatches === false).length,
      notesTypical: mode(withBar.map((r) => r.notes)),
      secondAttackShare: R.length ? r2(R.filter((r) => r.secondAttackMs != null).length / R.length) : null,
      secondAttackMs: r1(median(R.filter((r) => r.secondAttackMs != null).map((r) => r.secondAttackMs))),
      tapVsMusicDb: r1(median(R.map((r) => r.tapVsMusicDb))),
    };
  };
  const timingVerdict = (s) => !timingReliable ? 'UNRELIABLE' : human ? 'REPORT (human model)'
    : (Math.abs(s.tapVsBeatMs.median) <= TH.timingMedianMs && s.tapVsBeatMs.absP90 <= TH.timingP90Ms ? 'PASS' : 'FAIL');
  const pitchVerdict = (s) => !pitchReliable ? 'UNRELIABLE' : (s.sourRate == null ? 'UNRELIABLE' : s.sourRate <= TH.sourTapsMax ? 'PASS' : 'FAIL');

  const all = summarise(rows);
  const byVoice = {};
  for (const v of [...new Set(rows.map((r) => r.voice))]) {
    const s = summarise(rows.filter((r) => r.voice === v));
    s.pitch = pitchVerdict(s); s.timing = timingVerdict(s);
    byVoice[v] = s;
  }
  return {
    label, vibe: meta.vibe, opts: meta.opts, bot: meta.bot || null, sampleRate: sr, seconds: r1(dur),
    latency: meta.latency, windowsMs: meta.win ? { perfect: r1(meta.win.perfect * 1000), good: r1(meta.win.good * 1000), ok: r1(meta.win.ok * 1000) } : null,
    endStage: meta.stage, endBpm: meta.bpm,
    thresholds: TH, reliability,
    timing: Object.assign({ verdict: timingVerdict(all) }, all),
    byVoice,
    pitchVerdictAllVoices: pitchVerdict(all),
    phases: Object.fromEntries(Object.entries(phaseKey).map(([k, v]) => [k, NOTE[v.root] + (v.q === 'min' ? 'm' : '') + ` (${r2(v.score)})`])),
    bars: bars.map((b) => ({ phase: b.phase, from: r2(b.from), heard: chordName(b.est), sequencer: chordName(b.truth), agree: b.agree, score: r2(b.est.score) })),
    rows,
    errors: meta.errors || [],
  };
}
function mode(arr) { const m = new Map(); let best = null, bc = 0; for (const a of arr) { const c = (m.get(a) || 0) + 1; m.set(a, c); if (c > bc) { bc = c; best = a; } } return best; }

// ---------------- reporting ----------------
function toMarkdown(r) {
  const L = [];
  const o = r.opts || {};
  const ctl = o.delayMs ? `CONTROL: tap sound delayed ${o.delayMs} ms` : o.semitones ? `CONTROL: tap pitch shifted ${o.semitones} semitones` : 'clean (no control)';
  L.push(`### ${r.label || r.vibe} — ${ctl}`);
  L.push(`Song \`${r.vibe}\`, ${r.seconds} s recorded, ended at stage ${r.endStage} / ${r.endBpm} BPM. PERFECT window ±${r.windowsMs && r.windowsMs.perfect} ms at the end.`);
  const rl = r.reliability;
  L.push(`Self-checks: drum attack ${rl.kickAttackMs} ms after schedule (spread ${rl.kickSpreadMs} ms, ${rl.kicksMeasured} kicks); chords heard = sequencer on ${Math.round((rl.chordAgree || 0) * 100)}% of ${rl.barsChecked} bars; taps found ${rl.tapsFound}/${rl.tapsSounded}; skipped audio ${rl.gapMs} ms.`);
  const t = r.timing;
  const b = r.bot || {};
  L.push(`Bot: ${b.mode === 'human' ? `human model, seeded jitter σ ${b.sigmaMs} ms` : 'exact (taps when the game clock reaches the note)'}; voices ${(b.voices || ['classic']).filter((v, i, a) => a.indexOf(v) === i).join(', ')}.`);
  L.push(`**Timing: ${t.verdict}.** Tap attack vs the beat's drum attack: median ${t.tapVsBeatMs.median} ms, p10 ${t.tapVsBeatMs.p10}, p90 ${t.tapVsBeatMs.p90}, |p90| ${t.tapVsBeatMs.absP90} (range ${t.tapVsBeatMs.min} to ${t.tapVsBeatMs.max}). Press to sound ${t.pressToSoundMs.median} ms. Bot press vs beat ${t.pressVsBeatMs.median} ms (p90 ${t.pressVsBeatMs.p90})${t.botStalls ? `; ${t.botStalls} press(es) excluded as bot stalls (> ${r.thresholds.botStallMs} ms late)` : ''}.`);
  if (t.perfectOffBeyondFlamMs != null && r.rows.some((x) => x.jitterMs)) L.push(`PERFECT taps whose sound lands more than ${r.thresholds.flamMs} ms off the beat: ${Math.round(t.perfectOffBeyondFlamMs * 100)}%.`);
  L.push('');
  L.push('| Voice | Taps | Pitch | Sour taps | Chord-tone share | In-key share | Typical notes heard | Timing | Median / \\|p90\\| ms | 2nd attack | Tap vs music |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const [v, s] of Object.entries(r.byVoice)) {
    L.push(`| ${v} | ${s.n} | **${s.pitch}** | ${s.sourTaps}/${s.nPitch} (${Math.round((s.sourRate || 0) * 100)}%) | ${s.chordShareMean} | ${s.inKeyShareMean} | ${s.notesTypical || ''} | ${s.timing} | ${s.tapVsBeatMs.median} / ${s.tapVsBeatMs.absP90} | ${s.secondAttackShare ? `${Math.round(s.secondAttackShare * 100)}% at +${s.secondAttackMs} ms` : 'none'} | ${s.tapVsMusicDb} dB |`);
  }
  L.push('');
  L.push(`Chords heard per bar: ${r.bars.map((b) => b.heard + (b.agree ? '' : ` (seq ${b.sequencer})`)).join(' · ')}`);
  L.push(`Key heard per passage: ${Object.entries(r.phases).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  return L.join('\n');
}

// One table across runs: the per-song numbers Dennel and Rhythm QA read first.
function summaryMarkdown(results) {
  const L = [];
  L.push('| Run | Song | Control | Timing | Tap vs beat median / |p90| ms | Voice | Pitch | Sour taps | Chord-tone share | Notes heard | Chords heard = sequencer |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of results) {
    const o = r.opts || {};
    const ctl = o.delayMs ? `+${o.delayMs} ms delay` : o.semitones ? `+${o.semitones} semitones` : (r.bot && r.bot.mode === 'human' ? `human σ${r.bot.sigmaMs}` : '—');
    let first = true;
    for (const [v, s] of Object.entries(r.byVoice)) {
      L.push(`| ${first ? r.label : ''} | ${first ? r.vibe : ''} | ${first ? ctl : ''} | ${first ? r.timing.verdict : ''} | ${first ? `${r.timing.tapVsBeatMs.median} / ${r.timing.tapVsBeatMs.absP90}` : ''} | ${v} | **${s.pitch}** | ${s.sourTaps}/${s.nPitch} | ${s.chordShareMean} | ${s.notesTypical || ''} | ${first ? Math.round((r.reliability.chordAgree || 0) * 100) + '%' : ''} |`);
      first = false;
    }
  }
  return L.join('\n');
}

// 16-bit mono WAV, for listening to exactly what the bot heard.
function wav(samples, sr) {
  const n = samples.length, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return buf;
}

module.exports = { analyze, toMarkdown, summaryMarkdown, wav, TH, _dsp: { fftPow, chroma, bestChord, bestKey, tapNotes, attackAt, rmsEnv } };
