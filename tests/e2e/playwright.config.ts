import { defineConfig, devices } from "@playwright/test";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: {
    timeout: 15_000
  },
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    browserName: "chromium",
    channel: executablePath ? undefined : (process.env.PLAYWRIGHT_CHROME_CHANNEL ?? "chrome"),
    launchOptions: executablePath ? { executablePath } : undefined,
    trace: "on-first-retry"
  }
});
