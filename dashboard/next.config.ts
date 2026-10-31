import { join } from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["software-factory"],
  output: "standalone",
  // The workspace root, so the image finds the server at .next/standalone/dashboard/server.js.
  outputFileTracingRoot: join(__dirname, ".."),
};

export default config;
