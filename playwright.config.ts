import { defineConfig } from "@playwright/test";
import { randomUUID } from "node:crypto";
export default defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  use: {
    headless: true,
    launchOptions: {
      ...(process.env.CI ? {} : { executablePath: "/usr/bin/chromium" }),
      args: ["--no-sandbox"],
    },
    baseURL: "http://127.0.0.1:43130",
  },
  webServer: {
    command: "npm start",
    url: "http://127.0.0.1:43130/api/health",
    reuseExistingServer: false,
    env: { PORT: "43130", DATA_DIR: `/tmp/studio-v3-browser-${randomUUID()}` },
  },
  reporter: "list",
});
