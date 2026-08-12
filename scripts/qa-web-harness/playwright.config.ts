/**
 * Web 端 e2e harness 的 Playwright 配置。
 *
 * 运行：npx playwright test scripts/qa-web-harness/e2e.spec.ts
 * 或：  npx playwright test --config scripts/qa-web-harness/playwright.config.ts
 *
 * 前置：web-ui/ 静态产物已构建（npm run web-ui:build）；Playwright 浏览器
 * 已安装（npx playwright install chromium）。
 */
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: __dirname,
  testMatch: 'e2e.spec.ts',
  timeout: 300_000,
  expect: { timeout: 45_000 },
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
