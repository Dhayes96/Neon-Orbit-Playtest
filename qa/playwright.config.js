// @ts-check
const { defineConfig, devices } = require('@playwright/test');
const CHROME = process.env.CHROME_PATH || undefined; // CI uses bundled chromium
const audioArgs = ['--autoplay-policy=no-user-gesture-required'];
module.exports = defineConfig({
  testDir: './tests',
  timeout: 240_000,
  workers: 1,                 // timing tests must not compete for CPU
  reporter: [['list'], ['json', { outputFile: 'results/report.json' }]],
  outputDir: 'results/artifacts',
  use: {
    baseURL: 'http://127.0.0.1:4173/',
    trace: 'retain-on-failure',
    launchOptions: { executablePath: CHROME, args: audioArgs },
  },
  webServer: { command: 'node server.js', url: 'http://127.0.0.1:4173/index.html', reuseExistingServer: false }, // T0: never reuse a stale server from another checkout
  projects: [
    { name: 'stress-chrome', use: { ...devices['Desktop Chrome'], launchOptions: { executablePath: CHROME, args: audioArgs } }, testMatch: /stress\.spec/ },
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'], launchOptions: { executablePath: CHROME, args: audioArgs } }, testIgnore: /mobile\.spec|stress\.spec/ },
    { name: 'firefox-smoke', use: { ...devices['Desktop Firefox'], launchOptions: { firefoxUserPrefs: { 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0 } } }, testMatch: /smoke\.spec/ },
    { name: 'webkit-smoke', use: { ...devices['Desktop Safari'] }, testMatch: /smoke\.spec/ },
    { name: 'mobile-pixel7', use: { ...devices['Pixel 7'], launchOptions: { executablePath: CHROME, args: audioArgs } }, testMatch: /mobile\.spec/ },
  ],
});
