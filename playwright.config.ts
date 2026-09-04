import { defineConfig, devices } from "@playwright/test";

const deployedBaseURL = process.env.PLAYWRIGHT_BASE_URL?.trim();
const localBaseURL = "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results",
  // A cold local Vite server can briefly invalidate its generated client entry when
  // several projects request it during the first transform. Deployed Workers do not
  // have that dev-server race, so keep production smoke tests parallel while making
  // local regression runs deterministic.
  fullyParallel: Boolean(deployedBaseURL),
  workers: deployedBaseURL ? undefined : 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: deployedBaseURL || localBaseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: deployedBaseURL
    ? undefined
    : {
        command: "bun run dev -- --host 127.0.0.1 --port 4173",
        url: localBaseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
});
