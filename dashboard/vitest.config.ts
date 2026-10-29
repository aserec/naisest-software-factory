import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = { "@": fileURLToPath(new URL("./src", import.meta.url)) };
const esbuild = { jsx: "automatic" as const };

// Component tests (*.test.tsx) run in happy-dom, everything else in node.
// The node project hides node:sqlite's ExperimentalWarning.
// next-auth imports "next/server" without an extension, so vite must bundle it (inline) to resolve it.
export default defineConfig({
  test: {
    projects: [
      { esbuild, resolve: { alias }, test: { name: "dom", environment: "happy-dom", include: ["src/**/*.test.tsx"] } },
      { esbuild, resolve: { alias }, test: { name: "node", environment: "node", include: ["src/**/*.test.ts"], execArgv: ["--disable-warning=ExperimentalWarning"], server: { deps: { inline: ["next-auth"] } } } },
    ],
  },
});
