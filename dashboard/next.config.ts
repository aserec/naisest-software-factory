import { existsSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";

// One .env at the repo root serves the factory and the dashboard. A variable set in the shell wins.
const rootEnv = join(__dirname, "../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const config: NextConfig = {
  transpilePackages: ["software-factory"],
  output: "standalone",
  // The workspace root, so the image finds the server at .next/standalone/dashboard/server.js.
  outputFileTracingRoot: join(__dirname, ".."),
};

export default config;
