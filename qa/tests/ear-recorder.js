// In-page pieces for the ear-bot (test-only; the game is not modified).
//  installRecorder: an AudioWorklet in the game's own AudioContext that records the
//    tap (sfx) bus and the music bus, sample-accurately, on the audio clock.
//  installTapLog:   logs the game's chord state each time a tap sound plays.
//  startEarTapper:  taps each note when the audible step it sits on arrives
//    (optionally lateMs after it), polling on a ~1 ms timer instead of rAF so the
//    bot's own input timing doesn't depend on frame rate. Logs when each tap ran.
//  installControlTones: replaces the game's tap sound with a known signal for
//    analyzer validation: the game's own tone() scheduled on every beat at
//    +shiftMs, pitched `interval` semitones above the live chord root.
'use strict';

const WORKLET = `
class EarRec extends AudioWorkletProcessor {
  constructor() { super(); this.a = []; this.b = []; this.n = 0; this.first = -1; }
  mono(inp, len) {
    const out = new Float32Array(len);
    if (inp && inp.length) { for (const ch of inp) for (let i = 0; i < len; i++) out[i] += ch[i] / inp.length; }
    return out;
  }
  process(inputs) {
    const len = (inputs[0] && inputs[0][0] && inputs[0][0].length) || (inputs[1] && inputs[1][0] && inputs[1][0].length) || 128;
    if (this.first < 0) this.first = currentFrame;
    this.a.push(this.mono(inputs[0], len)); this.b.push(this.mono(inputs[1], len)); this.n += len;
    if (this.n >= 8192) {
      const cat = (arr) => { const o = new Float32Array(this.n); let k = 0; for (const c of arr) { o.set(c, k); k += c.length; } return o; };
      this.port.postMessage({ frame: this.first, tap: cat(this.a), music: cat(this.b) });
      this.a = []; this.b = []; this.n = 0; this.first = -1;
    }
    return true;
  }
}
registerProcessor('ear-rec', EarRec);`;

async function installRecorder(page) {
  await page.evaluate(async (src) => {
    const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    await audioCtx.audioWorklet.addModule(url);
    const node = new AudioWorkletNode(audioCtx, 'ear-rec', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1] });
    const chunks = [];
    node.port.onmessage = (e) => chunks.push(e.data);
    sfxGain.connect(node, 0, 0);        // tap bus (also carries other sfx; tap log filters them)
    musicLimiter.connect(node, 0, 1);   // music bus after its limiter
    const sink = audioCtx.createGain(); sink.gain.value = 0; node.connect(sink).connect(audioCtx.destination);
    window.__ear = { node, chunks, sink, sr: audioCtx.sampleRate };
  }, WORKLET);
}

// Returns { sr, startFrame, tap: Float32Array, music: Float32Array } in Node.
async function stopRecorder(page) {
  const out = await page.evaluate(() => {
    const { node, chunks, sink, sr } = window.__ear;
    try { sfxGain.disconnect(node); musicLimiter.disconnect(node); node.disconnect(); sink.disconnect(); } catch {}
    if (!chunks.length) return { sr, startFrame: 0, tap: '', music: '', gaps: 0, gapDetail: [] };
    const start = chunks[0].frame, last = chunks[chunks.length - 1];
    const total = last.frame + last.tap.length - start;
    const tap = new Float32Array(total), music = new Float32Array(total);
    let gaps = 0, expect = start; const gapDetail = [];
    for (const c of chunks) { if (c.frame !== expect) { gaps++; gapDetail.push({ at: expect, missingFrames: c.frame - expect }); } tap.set(c.tap, c.frame - start); music.set(c.music, c.frame - start); expect = c.frame + c.tap.length; }
    const b64 = (f) => { const u = new Uint8Array(f.buffer); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
    return { sr, startFrame: start, tap: b64(tap), music: b64(music), gaps, gapDetail };
  });
  const dec = (s) => { const b = Buffer.from(s, 'base64'); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };
  return { sr: out.sr, startFrame: out.startFrame, tap: dec(out.tap), music: dec(out.music), gaps: out.gaps, gapDetail: out.gapDetail };
}

async function installTapLog(page) {
  await page.evaluate(() => {
    const log = window.__tapLog = [];
    // Ground truth for "the chord playing when the tap sounds", kept independent of the
    // game's own chord lookup: record the chord of every step the sequencer schedules,
    // with its audio start time, then look up the latest step that has started at tap time.
    // (Until step 2 this read music.bar, the scheduler's bar, which runs up to a lookahead
    // ahead of the speaker, the same mistake the game made. Taps before the first
    // recorded step get no chord and are left out of the chord check, not counted as fits.)
    const sched = window.__chordSched = [];
    const prevStep = window.scheduleStep;
    window.scheduleStep = function (step, when) {
      try {
        const ph = music.active.phase; const slot = music.bar % ph.prog.length;
        sched.push({ when, root: ph.prog[slot] + (music.active.transpose || 0), quality: ph.quality[slot].slice() });
        if (sched.length > 4096) sched.splice(0, 2048);
      } catch {}
      return prevStep.apply(this, arguments);
    };
    const orig = TapVoice.play;
    TapVoice.play = function (grade) {
      let root = null, quality = null;
      const ac = audioCtx.currentTime;
      for (let i = sched.length - 1; i >= 0; i--) {
        if (sched[i].when <= ac) { root = (sched[i].root % 12 + 12) % 12; quality = sched[i].quality; break; }
      }
      log.push({ ac, grade, voice: TapVoice.id(), root, quality });
      return orig.apply(this, arguments);
    };
  });
}

async function startEarTapper(page, { lateMs = 0 } = {}) {
  await page.evaluate(({ lateMs }) => {
    const qa = window.__qa;
    const botLog = window.__botLog = [];
    function tick() {
      if ((state === 'playing' || state === 'bossBattle') && Conductor.ready()) {
        const ac = audioCtx.currentTime;
        for (const n of notes) {
          if (n.hit || n.missed || n.__earTapped) continue;
          const a = Conductor.gameToAudio(n.hitTime);
          if (n.__earW === undefined && ac > a - 0.12) {
            let best = null, bd = Infinity;
            for (const s of qa.steps) { const d = Math.abs(s.w - a); if (d < bd) { bd = d; best = s; } }
            n.__earW = best && bd < 0.15 ? best.w : a;
          }
          if (n.__earW === undefined) continue;
          if (ac >= n.__earW + lateMs / 1000) {
            n.__earTapped = true;
            botLog.push({ acHandler: audioCtx.currentTime, targetW: n.__earW });
            handleTap(null, true);
            break;
          }
        }
      }
      if (!window.__botStop) setTimeout(tick, 1);
    }
    tick();
  }, { lateMs });
}

async function installControlTones(page, { shiftMs = 0, interval = 24 } = {}) {
  await page.evaluate(({ shiftMs, interval }) => {
    const log = window.__tapLog = [];
    TapVoice.play = function () {};                 // silence the game's own tap sound
    const prev = window.scheduleStep;
    window.scheduleStep = function (step, when, stepDur) {
      const r = prev.apply(this, arguments);
      if (step % 4 === 0) {
        let root = 45, quality = null;
        // The chord of the step being scheduled (music.bar is that step's bar here). Not
        // liveChordRoot(), which since step 2 returns the chord heard NOW, a lookahead earlier.
        try { const ph = music.active.phase; const slot = music.bar % ph.prog.length; root = ph.prog[slot] + (music.active.transpose || 0); quality = ph.quality[slot].slice(); } catch {}
        const at = when + shiftMs / 1000;
        tone(midiHz(root + interval), 0.045, 'triangle', 0.045, Math.max(0, at - audioCtx.currentTime));
        log.push({ ac: at, grade: 'control', voice: 'control', root: (root % 12 + 12) % 12, quality });
      }
      return r;
    };
  }, { shiftMs, interval });
}

module.exports = { installRecorder, stopRecorder, installTapLog, startEarTapper, installControlTones };
