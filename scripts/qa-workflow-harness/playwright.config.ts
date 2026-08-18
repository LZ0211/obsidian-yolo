import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: __dirname,
  testMatch: 'e2e.spec.ts',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: `${__dirname}/test-results`,
  use: {
    headless: process.env.E2E_HEADED !== '1',
    trace: 'retain-on-failure',
  },
})
