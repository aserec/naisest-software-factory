// Absolute, because CI steps run with a bare PATH that has no node_modules/.bin.
// The sandbox-runtime binary path, kept in a leaf module that imports nothing from the factory.
import { fileURLToPath } from "node:url";

export const SRT = `${fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "")}/node_modules/.bin/srt`;
