# Known failures and non-blocking checks (as of Phase 1, 2026-10-31)

Blocking in CI (PR gate `fast` job): `npm run test:static` (except the `todo` guards below) and
smoke on Chromium desktop, Pixel 7 emulation, Firefox and WebKit. Any new failure there is a
real regression.

## Known Phase 2 failures (reported, not blocking)

| Check | Where | Marked as | Fixed by |
|---|---|---|---|
| audio output latency is compensated somewhere | `tests/static.test.js` | node:test `todo` | T14 · RV-06 |
| tap judgement uses the input event timestamp | `tests/static.test.js` | node:test `todo` | T8 · RV-05 |
| in-flight notes stay on the audio grid after a tab resume | `tests/timing.spec.js` (nightly) | `test.fail()` (expected failure) | T6 · RV-03 |

When the fixing task lands, remove the marker in the same PR. For the `test.fail()` case,
Playwright reports "expected to fail, but passed", which turns CI red until the marker goes.

## Known flaky (blocking, with one visible retry)

- **Firefox smoke "start run"** (`firefox-smoke` project). On GitHub runners Firefox's AudioContext
  sometimes takes more than 5 s to reach `running`, even with the PulseAudio null sink (it failed 1 of 4
  runs on 2026-11-01). Firefox gets 15 s for audio start-up, and the project has `retries: 1`. A
  pass on retry shows as **flaky** in the report, so it isn't silent. Two failures in a row still fail CI.
- **WebKit smoke "start run"** (`webkit-smoke` project). Once on 2026-11-01, WebKit's sequencer
  scheduled 29 sixteenth-steps in 10 s against the `> 30` floor (about 49 expected in real time). The
  floor is **not** lowered, because a low count means steps really were late or dropped. Instead the
  project has `retries: 1` (shown as flaky). Root cause belongs to Phase 2 **T7 (RV-14, scheduler
  headroom)**, which the 6× CPU-throttle stress test also reports (report-only).

## Informational, non-blocking

- **Lighthouse CI** (`lighthouse` job, `continue-on-error: true`). Reports are still generated every run and kept as the private `lighthouse-reports` Actions artifact (30 days), so performance reporting is preserved. Its strict `lighthouse:no-pwa`
  preset fails on the single-file build (unminified inline JS/CSS, unused JS, viewport). Note: it
  still uploads reports to Lighthouse's temporary **public** storage; whether to keep that is
  Dennel's call.
- **perf: frame-time budget** (`tests/timing.spec.js`, nightly). The test is headless-only, as its
  title says ("headless = smoke only"). On a 2-core sandbox it sits at p95 33.4 ms on base and on
  every Phase 1 branch, because frames snap to vsync multiples. Treat it as a trend signal, not
  a gate. Real-device frame pacing is part of the manual checklist.
- **RV-08 soak** (`tests/rv08-soak.spec.js`): report-only by design; run with `RV_SOAK_MIN=10`.
