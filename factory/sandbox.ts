// The sandbox rules shared by the agent and by install and gate commands.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESS_HOMES, type Harness } from "./seams";

// Absolute paths in the factory checkout. Never relative to the agent cwd, which is the target clone.
export const SANDBOX_RULES_PATH = fileURLToPath(new URL("./sandbox-rules.json", import.meta.url));
const RULES = JSON.parse(readFileSync(SANDBOX_RULES_PATH, "utf8"));
const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

// A harness's home and session dir for one run, next to the clone.
export const harnessHome = (h: Harness, cwd: string) => join(dirname(cwd), h.home);

// What no sandboxed command (agent Bash, install, gate) may read: /proc (from sandbox-rules.json), the factory checkout's .git (it may hold
// CI_JOB_TOKEN in its remote URL), the runner's File-variable dir <project dir>.tmp, every harness home (sessions and config).
export const sandboxDenyRead = (cwd: string) => [...RULES.filesystem.denyRead, `${ROOT}/.git`, `${ROOT}.tmp`, ...Object.values(HARNESS_HOMES).map((h) => join(dirname(cwd), h))];
