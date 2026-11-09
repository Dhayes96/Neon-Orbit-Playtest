// Ear-bot (listening), in-page side. Test-only: evaluated into the page by the
// harness; index.html is never modified.
//
// What it does, all inside the running game:
//   - records three stems of the REAL rendered audio, sample-accurately, with an
//     AudioWorklet on the live graph:
//       music = musicLimiter output (everything the song plays)
//       taps  = only the tap sounds (TapVoice.play), routed through a pass-through
//               gain so they can be heard alone; the game still hears them exactly
//               as before, at the same level
//       mix   = masterLimiter output (what goes to the speakers)
//   - logs what the sequencer scheduled (step times, kick/clap flags, the chord of
//     each bar) as ground truth, so the analysis can be checked against it
//   - taps every note with a bot (exact, or with seeded human-like jitter)
//   - optional known-bad CONTROLS, injected here so the analyzer can prove it fails:
//       delayMs   : the tap sound is delayed by N ms on its way to the speakers
//       semitones : every tap pitch is shifted by N semitones
//
// Wraps (same seams the QA harness already uses): scheduleStep, tone, percTap
// (global function declarations) and TapVoice.play (a method on a const object).
// Reads/assigns top-level let bindings (sfxGain, audioCtx, music, ...) from the
// shared global lexical scope.
(() => {
  if (window.__earbot) return;

  const WORKLET_SRC = `
  class EarbotRecorder extends AudioWorkletProcessor {
    constructor(opts) {
      super();
      this.k = opts.numberOfInputs;
      this.size = 128 * 64;                       // ~170 ms per message at 48 kHz
      this.bufs = Array.from({ length: this.k }, () => new Float32Array(this.size));
      this.pos = 0; this.start = -1; this.on = true;
      this.port.onmessage = (e) => { if (e.data === 'stop') { this.flush(); this.on = false; this.port.postMessage({ done: true, stale: this.stale || 0 }); } };
    }
    flush() {
      if (this.pos === 0) return;
      const data = this.bufs.map((b) => b.slice(0, this.pos));
      this.port.postMessage({ start: this.start, len: this.pos, data }, data.map((d) => d.buffer));
      this.pos = 0; this.start = -1;
    }
    process(inputs) {
      if (!this.on) return false;
      // process() runs once per 128-frame quantum, so frames are counted from the
      // first call. Under load Chrome can report a STALE currentFrame for a few
      // quanta (it lags, then catches up); those are counted, not trusted. A
      // currentFrame AHEAD of the count means quanta really were skipped (e.g.
      // when rendering moves to the worklet thread at start-up): that starts a
      // new chunk at the real frame and is reported as a gap, never hidden.
      const cf = currentFrame;
      if (this.next === undefined) this.next = cf;
      if (cf > this.next) {
        this.port.postMessage({ jump: { expected: this.next, got: cf } });
        this.flush();
        this.next = cf;
      } else if (cf < this.next) this.stale = (this.stale || 0) + 1;
      if (this.start < 0) this.start = this.next;
      this.next += 128;
      let n = 128;
      for (let k = 0; k < this.k; k++) {
        const ch = inputs[k] || [];
        const out = this.bufs[k];
        if (ch.length) n = ch[0].length;
        if (!ch.length) { for (let i = 0; i < n; i++) out[this.pos + i] = 0; }
        else if (ch.length === 1) { out.set(ch[0], this.pos); }
        else { const a = ch[0], b = ch[1]; for (let i = 0; i < n; i++) out[this.pos + i] = 0.5 * (a[i] + b[i]); }
      }
      this.pos += n;
      if (this.pos + 128 > this.size) this.flush();
      return true;
    }
  }
  registerProcessor('earbot-recorder', EarbotRecorder);`;

  const eb = window.__earbot = {
    opts: {}, inTap: false, chunks: [], jumps: [], taps: [], botTaps: [], sched: [], errors: [],
    tapIn: null, recorder: null, sampleRate: 0, recording: false,
    latency: null,
  };

  // ---- seeded RNG for the human-jitter bot (never touches Math.random) ----
  function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

  // ---- 1. wrappers: install BEFORE the run starts so the first bars are logged ----
  eb.wrap = function (opts) {
    eb.opts = Object.assign({ delayMs: 0, semitones: 0, voices: null }, opts || {});
    const pitchMul = Math.pow(2, (eb.opts.semitones || 0) / 12);

    // Ground truth from the sequencer: what was scheduled, and when it sounds.
    const realStep = scheduleStep;
    window.scheduleStep = function (step, when, stepDur) {
      try {
        const prof = personalityProfile();
        const w = (prof.swing && step % 4 === 2) ? when + stepDur * prof.swing : when;
        const r = music.active, ph = r && r.phase;
        if (ph && ph.prog) {
          const slot = (music.bar + (r.rotate || 0)) % 4;
          eb.sched.push({ step, w, stepDur, bar: music.bar, phase: ph.name, rotate: r.rotate || 0,
            root: ph.prog[slot] + (r.transpose || 0), quality: (ph.quality[slot] || [0, 3, 7]).join(','),
            kick: !!(ph.kick && ph.kick[step]), clap: !!(ph.clap && ph.clap[step]),
            xfade: !!(music.prev && w < music.prevUntil), boss: (typeof bossMusicMix === 'number' ? bossMusicMix : 0),
            continuous: (typeof musicIsContinuous === 'function') ? musicIsContinuous() : true });
        }
      } catch (e) { eb.errors.push('sched: ' + e.message); }
      return realStep.apply(this, arguments);
    };

    // Tap sounds: route through eb.tapIn (pass-through) and log what the game chose.
    const realPlay = TapVoice.play;
    TapVoice.play = function (grade) {
      const rec = { grade, voice: TapVoice.id(), ctx: audioCtx ? audioCtx.currentTime : null,
        perf: performance.now(), gameRoot: liveChordRoot(), schedBar: music.bar, sounded: false };
      eb.taps.push(rec);
      const keep = sfxGain;
      if (eb.tapIn) sfxGain = eb.tapIn;
      eb.inTap = true;
      try { return realPlay.apply(this, arguments); }
      finally { eb.inTap = false; sfxGain = keep; }
    };
    // Pitch control + "did a sound actually get created" bookkeeping.
    const realTone = tone;
    window.tone = function (freq, dur, type, gain, delay) {
      if (eb.inTap) { const t = eb.taps[eb.taps.length - 1]; if (t) t.sounded = true; freq = freq * pitchMul; }
      return realTone.call(this, freq, dur, type, gain, delay);
    };
    const realPerc = percTap;
    window.percTap = function (o) {
      if (eb.inTap) {
        const t = eb.taps[eb.taps.length - 1]; if (t) t.sounded = true;
        if (o && o.hz && pitchMul !== 1) o = Object.assign({}, o, { hz: o.hz * pitchMul });
      }
      return realPerc.call(this, o);
    };
  };

  // ---- 2. recorder + tap path: install once audio exists (after Start) ----
  eb.startRecording = async function () {
    const ctx = audioCtx;
    if (!ctx || !musicLimiter || !masterLimiter || !sfxGain) throw new Error('audio graph not ready');
    eb.sampleRate = ctx.sampleRate;
    eb.latency = { baseLatency: ctx.baseLatency || 0, outputLatency: ctx.outputLatency || 0 };
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    const rec = new AudioWorkletNode(ctx, 'earbot-recorder', {
      numberOfInputs: 3, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    rec.port.onmessage = (e) => {
      if (e.data && e.data.done) { eb.staleQuanta = e.data.stale; eb.recording = false; return; }
      if (e.data && e.data.jump) { eb.jumps.push(e.data.jump); return; }
      eb.chunks.push(e.data);
    };
    // Tap path: tapIn -> [control delay] -> sfxGain. The recorder listens AFTER the
    // delay, i.e. to what the player would hear.
    const tapIn = ctx.createGain(); tapIn.gain.value = 1;
    let tapOut = tapIn;
    if (eb.opts.delayMs > 0) {
      const d = ctx.createDelay(1.0); d.delayTime.value = eb.opts.delayMs / 1000;
      tapIn.connect(d); tapOut = d;
    }
    tapOut.connect(sfxGain);
    musicLimiter.connect(rec, 0, 0);
    tapOut.connect(rec, 0, 1);
    masterLimiter.connect(rec, 0, 2);
    const mute = ctx.createGain(); mute.gain.value = 0;   // keeps the recorder pulled; adds silence
    rec.connect(mute).connect(ctx.destination);
    eb.tapIn = tapIn; eb.recorder = rec; eb.recording = true;
    eb.recStartCtx = ctx.currentTime;
  };

  // ---- 3. the tapping bot ----
  // mode 'exact': tap each note when the game clock reaches its hit time (+lateMs).
  // mode 'human': same, plus seeded Gaussian jitter (sigmaMs) per note.
  // Polls with a MessageChannel near the target so taps aren't frame-quantised.
  eb.startBot = function ({ mode = 'exact', sigmaMs = 0, lateMs = 0, seed = 7, voices = null } = {}) {
    eb.botOpts = { mode, sigmaMs, lateMs, seed, voices };
    const r = rng(seed);
    const mc = new MessageChannel();
    let pending = null;
    eb.botStop = false;
    let voiceIdx = 0;
    function gameNow() { return clockNow() - startTime; }
    function fire() {
      if (!pending) return;
      const { n, target } = pending;
      if (n.hit || n.missed || !(state === 'playing' || state === 'bossBattle')) { pending = null; return; }
      if (gameNow() < target) { mc.port2.postMessage(0); return; }
      pending = null;
      n.__ebTapped = true;
      if (voices && voices.length) { save.settings.tapVoice = voices[voiceIdx % voices.length]; voiceIdx++; }
      const before = { p: runStats.perfects, g: runStats.goods, o: runStats.oks, m: runStats.misses };
      const tGame = gameNow();
      const ctxAt = audioCtx.currentTime;
      const nTaps = eb.taps.length;
      handleTap(null, true);
      const res = runStats.perfects > before.p ? 'PERFECT' : runStats.goods > before.g ? 'GOOD' : runStats.oks > before.o ? 'OK' : runStats.misses > before.m ? 'MISS' : 'NONE';
      eb.botTaps.push({ hitAudio: Conductor.gameToAudio(n.hitTime), errMs: (tGame - (n.hitTime + audioOffset())) * 1000,
        jitterMs: (target - n.hitTime - audioOffset()) * 1000, ctxAt, res, voice: save.settings.tapVoice, tapIdx: eb.taps.length > nTaps ? nTaps : -1, stage, bpm });
    }
    mc.port1.onmessage = fire;
    function tick() {
      if (eb.botStop) return;
      if (!pending && (state === 'playing' || state === 'bossBattle') && Conductor.ready()) {
        const now = gameNow();
        let best = null;
        for (const n of notes) {
          if (n.hit || n.missed || n.__ebTapped) continue;
          if (n.__ebJit === undefined) n.__ebJit = mode === 'human' ? gauss(r) * sigmaMs / 1000 : 0;
          const target = n.hitTime + audioOffset() + lateMs / 1000 + n.__ebJit;
          if (!best || target < best.target) best = { n, target };
        }
        if (best && best.target - now < 0.03) {
          pending = best;
          const wait = Math.max(0, (best.target - now) * 1000 - 3);
          setTimeout(() => mc.port2.postMessage(0), wait);
        }
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  };

  eb.stop = async function () {
    eb.botStop = true;
    if (eb.recorder && eb.recording) {
      const done = new Promise((res) => { const t0 = performance.now(); (function w() { if (!eb.recording || performance.now() - t0 > 3000) res(); else setTimeout(w, 20); })(); });
      eb.recorder.port.postMessage('stop');
      await done;
    }
  };

  // Stitch chunks into contiguous stems (a frame gap would be reported, never hidden).
  eb.assemble = function () {
    const ch = eb.chunks;
    if (!ch.length) return { frames: 0, gaps: [], jumps: eb.jumps };
    const start = Math.min(...ch.map((c) => c.start));
    const end = Math.max(...ch.map((c) => c.start + c.len));
    const total = end - start;
    const stems = [0, 1, 2].map(() => new Float32Array(total));
    const covered = new Uint8Array(Math.ceil(total / 128));
    for (const c of ch) {
      for (let k = 0; k < 3; k++) stems[k].set(c.data[k], c.start - start);
      for (let q = 0; q < c.len; q += 128) covered[((c.start - start) + q) >> 7] = 1;
    }
    // Uncovered quanta = frames the context skipped (left as silence, reported).
    const gaps = [];
    for (let q = 0; q < covered.length; q++) {
      if (covered[q]) continue;
      let e = q; while (e < covered.length && !covered[e]) e++;
      gaps.push({ fromFrame: start + q * 128, frames: (e - q) * 128 }); q = e;
    }
    eb.stems = stems; eb.stemStart = start;
    return { frames: total, startFrame: start, gaps, jumps: eb.jumps, staleQuanta: eb.staleQuanta || 0 };
  };
  // Base64 slices of a stem as 16-bit PCM-free float32 (exact), for transfer out.
  eb.slice = function (k, from, len) {
    const s = eb.stems[k].subarray(from, Math.min(eb.stems[k].length, from + len));
    const u8 = new Uint8Array(s.buffer, s.byteOffset, s.byteLength);
    let bin = '';
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  eb.meta = function () {
    return { sampleRate: eb.sampleRate, startFrame: eb.stemStart, latency: eb.latency, opts: eb.opts, bot: eb.botOpts || null,
      taps: eb.taps, botTaps: eb.botTaps, sched: eb.sched, errors: eb.errors,
      vibe: save.settings.musicVibe, difficulty: save.difficulty, stage, bpm,
      win: windows(), userAgent: navigator.userAgent };
  };
})();
