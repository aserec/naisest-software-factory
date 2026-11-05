// One-off: the dev server on https://localhost:3000, no build, to read React's dev-only hydration warnings.
import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: ".", testMatch: "hydration.check.ts", reporter: "list", use: { ignoreHTTPSErrors: true }, projects: [{ name: "chromium", use: { browserName: "chromium" } }] });
