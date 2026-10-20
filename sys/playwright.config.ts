import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/browser.spec.ts',
  timeout: 30000,
  use: { headless: true, screenshot: 'only-on-failure', trace: 'retain-on-failure',
    launchOptions: process.env.CORAL_BROWSER_EXECUTABLE ? { executablePath: process.env.CORAL_BROWSER_EXECUTABLE } : {} },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 900 } } },
  ],
});
