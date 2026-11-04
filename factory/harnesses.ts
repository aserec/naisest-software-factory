// The harnesses the factory can run an agent with. router.yml names one of these.
import { claudeCode } from "./adapters/claude-code";
import { pi } from "./adapters/pi";
import type { Harness } from "./seams";

export const HARNESSES = { "claude-code": claudeCode, pi } satisfies Record<string, Harness>;
export type HarnessName = keyof typeof HARNESSES;
export const HARNESS_NAMES = Object.keys(HARNESSES) as [HarnessName, ...HarnessName[]];
