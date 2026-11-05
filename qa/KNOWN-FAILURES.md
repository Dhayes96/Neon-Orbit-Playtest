# Known failures and non-blocking checks (as of Phase 1, 2026-10-31)

Blocking in CI (PR gate `fast` job): `npm run test:static` (except the `todo` guards below) and
smoke on Chromium desktop, Pixel 7 emulation, Firefox and WebKit. Any new failure there is a
real regression.

## Known Phase 2 failures (reported, not blocking)

| Check | Where | Marked as | Fixed by |
|---|---|---|---|
| audio output latency is compensated somewhere | `tests/static.test.js` | node:test `todo` | T14 · RV-06 |
| tap judgement uses the input event timestamp | `tests/static.test.js` | node:test `todo` | T8 · RV-05 |

When the fixing task lands, remove the marker in the same PR.

**Fixed:** the RV-03 tab-resume test (`tests/timing.spec.js`) was a `test.fail()` known failure
until Phase 2 T6. It now passes and is a normal regression guard; its marker was removed in the T6 PR.

## Known flaky (blocking, with one visible retry)

- **Firefox smoke "start run"** (`firefox-smoke` project). On GitHub runners Firefox's AudioContext
  sometimes takes more than 5 s to reach `running`, even with the PulseAudio null sink (it failed 1 of 4
  runs on 2026-11-01). Firefox gets 15 s for audio start-up, and the project has `retries: 1`. A
  pass on retry shows as **flaky** in the report, so it isn't silent. Two failures in a row still fail CI.
- **WebKit smoke "start run"** (`webkit-smoke` project). On 2026-11-01 and again on main `2415f61`
  (2026-11-04), WebKit's sequencer scheduled 28–29 sixteenth-steps in 10 s against the `> 30` floor.
  Diagnosed 2026-11-04 (`diag/webkit-smoke`): the audio clock was fine, but the CI WebKit main thread
  ran at ~5 fps, so the 25 ms music timer fired 200–330 ms late and the fixed 140 ms lookahead
  dropped 3–21 beats per run. **Fixed by T7 (RV-14, adaptive scheduler headroom, 140–500 ms).** The
  floor was not lowered, and the smoke test now also fails on more than 1 dropped beat in 10 s. The
  project keeps `retries: 1`.

## Informational, non-blocking

- **Lighthouse CI** (`lighthouse` job, `continue-on-error: true`). Reports are still generated every run and kept as the private `lighthouse-reports` Actions artifact (30 days), so performance reporting is preserved. Its strict `lighthouse:no-pwa`
  preset fails on the single-file build (unminified inline JS/CSS, unused JS, viewport). Reports are
  written to the runner's filesystem only (`--upload.target=filesystem`); nothing is published to
  Lighthouse's public storage (Dennel, 2026-11-01).
- **perf: frame-time budget** (`tests/timing.spec.js`, nightly). The test is headless-only, as its
  title says ("headless = smoke only"). On a 2-core sandbox it sits at p95 33.4 ms on base and on
  every Phase 1 branch, because frames snap to vsync multiples. Treat it as a trend signal, not
  a gate. Real-device frame pacing is part of the manual checklist.
- **RV-08 soak** (`tests/rv08-soak.spec.js`): report-only by design; run with `RV_SOAK_MIN=10`.
