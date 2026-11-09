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

## Ear-bot (rhythm bot step 1, test-only)

Listens to the game's real rendered audio and reports, per song, how far each
tap sound lands from the nearest 1/16 step and whether its pitch fits the music.

    npm run test:ear-unit      # analyzer self-test on synthetic audio (no browser)
    npm run test:ear           # Chromium + WebKit, all songs, ~6 min per browser
    EAR_SONGS=voidMetal,darkWave EAR_SECONDS=40 npx playwright test tests/ear-bot.spec.js --project=chrome-ear

- `tests/ear-recorder.js` records the tap (sfx) bus and the music bus with an
  AudioWorklet in the game's own AudioContext, on the audio clock, and logs the
  game's chord at each tap sound.
- `tests/ear-analysis.js` finds tap onsets, their pitch (FFT), the key heard in
  the music around them (Krumhansl), and semitone clashes (heard, and against the
  game's own chord).
- `control-*` tests must pass first: a known on-beat in-key tone is not flagged;
  a tone 45 ms late, a tritone tone, and a bot tapping 45 ms late are flagged.
- Raw numbers per song: `results/ear-<song>-<voice>.json` (timing histogram,
  per-tap pitches, chord, heard key, bot input vs game-added delay).
- Can't measure: device output latency, speakers/Bluetooth, or feel. Real device only.
