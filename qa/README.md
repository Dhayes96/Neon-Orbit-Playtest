# Rhythm Void QA prototype (Agent 3)

Read-only harness. It serves `../game` with a tiny static server and drives the
unmodified `index.html` with Playwright. Probes wrap global function
declarations (`spawnNote`, `scheduleStep`) and read top-level bindings
(`clockNow`, `notes`, `bpm`, `music`, `Conductor`, `runStats`, ...) via
`page.evaluate`. `Math.random` is seeded via an init script.

    npm ci && npx playwright install chromium firefox
    npm run test:static        # node:test source invariants (no browser)
    CHROME_PATH=/usr/bin/google-chrome npm run test:all   # or omit CHROME_PATH to use bundled chromium

Metrics land in `results/*.json`. Several timing tests are EXPECTED to fail at
commit 5b27f5e: they pin the BPM-ramp / swing / dropped-step defects described
in `../findings/agent3-qa.md`.

## Ear-bot (listening): Rhythm bot step 1

Opt-in, test-only (`index.html` is never modified). It records the game's **real
audio** while a bot plays, then listens to it for two things:

- **(a) Timing:** how far each tap sound lands from the beat. This is the tap's
  attack measured against the attack of the song's drums on that beat.
- **(b) Pitch:** whether each tap's notes fit the chord the music is playing at
  that moment.

Run it (about 10 minutes; not part of the PR gate):

    EARBOT=1 npx playwright test tests/earbot-listen.spec.js --project=desktop-chrome
    # or: npm run test:earbot
    # options: EARBOT_SONGS=voidMetal,cyberBounce  EARBOT_SECS=40  EARBOT_STEMS=1  EARBOT_STRICT=1

### Output

Results land in `results/earbot/`:

- `summary.md`: one table across all runs.
- `<run>.md` and `<run>.json`: raw numbers for every tap.
- `<run>-mix.wav`: exactly what the bot heard. With `EARBOT_STEMS=1`, the
  music and taps stems are written too.

### How it listens (`earbot/inpage.js` + `earbot/analyze.js`)

**Recording.** An AudioWorklet records three stems on the AudioContext
timeline, sample-accurately:

- `music`: the musicLimiter output.
- `taps`: only the tap sounds. They are routed through a pass-through gain, so
  the game's own output is unchanged.
- `mix`: the masterLimiter output, i.e. what reaches the speakers.

**Bot.** The bot calls `handleTap` like the other harness bots. It polls the
game clock with a MessageChannel instead of rAF, so taps aren't
frame-quantised. In the clean runs it rotates the tap voices: Classic on every
other tap, plus Pluck, Kick and Rim. It records `pressVsBeatMs` (when it
pressed, relative to the beat) and `pressToSoundMs` (press to sound).

**Timing.** Every sound's attack uses one rule: the first crossing of
baseline + 30% of the rise. `tapVsBeatMs` is the tap's attack minus where the
kick attacks land on that beat. The kick attack offset is measured from the
same recording.

**Pitch.**

- Chord sounding: the chroma of the music stem, per bar, matched to 24
  major/minor triads.
- Tap notes: the prominent spectral peaks of the taps stem, from 100 Hz to
  6 kHz. Below 100 Hz a short tap can't resolve a pitch class. A peak smeared
  over more than half an octave is a pitch glide, such as the Kick's thump,
  and isn't counted as a note.
- Each tap's energy is split into three shares:
  - **chord tone**
  - **color**: in the scale, or not rubbing a chord tone
  - **sour**: a semitone off a chord tone and outside the chord's scale, i.e.
    minor b2 / M3 / b5 / M7, or major b2 / m3 / b5 / b6.

  A tap is sour if at least half its pitched energy is sour.

### Verdicts

The thresholds were fixed before any song was measured (`TH` in
`analyze.js`):

- **Timing PASS:** |median| ≤ 10 ms and |p90| ≤ 20 ms.
- **Pitch PASS:** at most 15% sour taps per voice.

Presses more than 25 ms later than the bot intended are main-thread stalls in
the harness. They are excluded and counted.

### Self-checks

If any of these fails, the result is reported as UNRELIABLE instead of PASS:

- Drum alignment: the spread of the kick attack offset must stay ≤ 2 ms. If
  it grows, the recording timeline is off.
- Chords heard must match the sequencer on ≥ 80% of bars.
- ≥ 90% of tap sounds must be found in the audio.
- Skipped audio must stay < 1% of the recording.

### Controls

These are the only hard pass/fail tests. They prove the bot can fail:

- Tap sound delayed **30 ms** (cyberBounce) and **60 ms** (voidMetal): timing
  must FAIL, and the measured shift must match the delay.
- Tap pitch shifted a **tritone** (Pluck on cyberBounce): pitch must FAIL, and
  timing must still PASS.

### Limits: what it cannot hear

- **The device.** The bot taps from the game clock, so headless runs have no
  speaker delay (`outputLatency`), Bluetooth delay or touch delay. A player who
  taps in time with what they hear makes every tap sound land late by roughly
  speaker delay + touch delay. Only a real phone can measure that.
- **Song sections.** Runs cover each song's opening passage at stages 1–4.
  Raise `EARBOT_SECS` for later phases.
