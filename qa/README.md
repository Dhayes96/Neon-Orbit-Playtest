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
