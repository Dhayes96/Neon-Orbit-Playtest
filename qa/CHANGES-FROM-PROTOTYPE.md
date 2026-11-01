# qa-bundle vs qa-prototype (cross-review changes by Jarvis, 2026-10-31)
1. tests/harness.js: marks notes the game itself clears (beginLevelPause, startBossEncounter, startDragonEncounter, defeatBoss, endBossEncounter, enterRealm, exitRealm) as `cleared`.
2. tests/timing.spec.js: grid analysis skips cleared notes by default (set INCLUDE_CLEARED=1 for the old behaviour). Without this, notes deleted at a level-up and never shown were counted as off-grid.
3. tests/timing.spec.js: new test "in-flight notes stay on the audio grid (or are cleared) after a tab resume" (RV-03). It FAILS on 5b27f5e today.
4. tests/static.test.js: the swing guard now passes once Conductor.swing() stops reading the never-assigned `music.active.prof` (the old guard required that string to exist, so it could never pass on a fixed build).
Executed on this box (headless Chrome 156): the bundle's grid(cyberBounce) and resume tests fail on 5b27f5e as intended. The full bundle suite was NOT re-run end to end, and it has never run on GitHub Actions.
Install: copy this folder to `qa/` in the game repo, `npm ci`, `npx playwright install --with-deps`, copy `ci/rhythm-void-qa.yml` to `.github/workflows/qa.yml`.
