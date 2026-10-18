import { defineConfig } from '@playwright/test'

const baseURL = 'http://127.0.0.1:5178'

export default defineConfig({
  testDir: './tests',
  workers: 1,
  use: {
    baseURL,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : undefined,
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5178 --strictPort',
    url: baseURL,
    timeout: 30_000,
  },
})
