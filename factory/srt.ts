// Absolute, because CI steps run with a bare PATH that has no node_modules/.bin.
// A leaf module: harness adapters import it, and they must not import sandbox.ts (which imports them).
import { fileURLToPath } from "node:url";

export const SRT = `${fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "")}/node_modules/.bin/srt`;
