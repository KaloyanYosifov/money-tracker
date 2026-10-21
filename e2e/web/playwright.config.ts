import { defineConfig, devices } from "@playwright/test";

import { WEB_URL } from "../support/stack.ts";

const BROWSERS = [
  { name: "chromium", device: devices["Desktop Chrome"] },
  { name: "firefox", device: devices["Desktop Firefox"] },
  { name: "webkit", device: devices["Desktop Safari"] },
];

// The specs share one Compose stack and one database. Each test makes its own users, so the
// spec files run in parallel. offline.spec.ts changes the one shared Toxiproxy, so it runs
// alone: after all other specs, and one browser after the other.
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 4,
  // TOTP codes work once per 30-second step, so a login can wait up to 30 seconds.
  timeout: 240_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: WEB_URL,
    locale: "en-GB",
    trace: "retain-on-failure",
  },
  projects: [
    ...BROWSERS.map(({ name, device }) => ({
      name,
      testIgnore: "offline.spec.ts",
      use: { ...device },
    })),
    ...BROWSERS.map(({ name, device }, index) => ({
      name: `${name}-offline`,
      testMatch: "offline.spec.ts",
      dependencies: index === 0 ? BROWSERS.map((b) => b.name) : [`${BROWSERS[index - 1].name}-offline`],
      use: { ...device },
    })),
  ],
});
