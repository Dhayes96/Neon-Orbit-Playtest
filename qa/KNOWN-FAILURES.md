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
