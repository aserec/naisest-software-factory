import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

// The app and a stub GitLab (started by e2e/seed.ts) both run on localhost.
export const APP = "http://localhost:3190"; // not 3100, which Loki takes by default
export const STUB_PORT = 3191;
const db = join(tmpdir(), "factory-e2e.db");

// Set here, so the workers (which load this file again) see the same values.
process.env.AUTH_SECRET ??= "e2e-secret-e2e-secret-e2e-secret-0";
process.env.FACTORY_DASHBOARD_TOKEN ??= "e2e-factory-token";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "*.spec.ts",
  globalSetup: "./e2e/seed.ts",
  workers: 1,
  reporter: "list",
  use: { baseURL: APP },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    // A fresh database on every run. The seed then posts events to the real collector route.
    command: `node -e "for (const s of ['', '-wal', '-shm']) require('fs').rmSync(process.env.DASHBOARD_DB + s, { force: true })" && pnpm exec next build && pnpm exec next start -p 3190`,
    url: `${APP}/sign-in`,
    timeout: 300_000,
    reuseExistingServer: false,
    env: {
      DASHBOARD_DB: db,
      DASHBOARD_URL: APP,
      AUTH_URL: APP,
      AUTH_SECRET: process.env.AUTH_SECRET,
      FACTORY_DASHBOARD_TOKEN: process.env.FACTORY_DASHBOARD_TOKEN,
      GITLAB_URL: `http://localhost:${STUB_PORT}`,
      GITLAB_READ_TOKEN: "stub",
      FACTORY_PROJECT_ID: "1",
      TARGETS_DIR: join(process.cwd(), "e2e/targets"),
    },
  },
});
