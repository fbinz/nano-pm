// @ts-check
const { defineConfig, devices } = require('@playwright/test');
const { availableParallelism } = require('os');

module.exports = defineConfig({
  testDir: './tests',
  // Each worker provisions its own Django server, OS-assigned port and temporary
  // SQLite database through fixtures.js. Tests still reset before every case.
  fullyParallel: true,
  workers: Math.min(4, availableParallelism()),
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    trace: 'retain-on-failure',
    actionTimeout: 8000,
    navigationTimeout: 30000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
