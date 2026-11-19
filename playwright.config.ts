import { defineConfig, devices } from '@playwright/test'

const PREVIEW_URL = 'http://localhost:18799'

export default defineConfig({
  testDir: 'tests',
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  outputDir: 'test-results',
  use: { baseURL: PREVIEW_URL, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: { command: 'npm run web:preview', url: `${PREVIEW_URL}/health`, reuseExistingServer: !process.env.CI, timeout: 120_000 },
})
