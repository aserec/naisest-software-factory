// The sandbox rules shared by the agent and by install and gate commands.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESS_HOMES, type Harness } from "./seams";

// Absolute paths in the factory checkout. Never relative to the agent cwd, which is the target clone.
export const SETTINGS_PATH = fileURLToPath(new URL("../.claude/factory-settings.json", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

// A harness's home and session dir for one run, next to the clone.
export const harnessHome = (h: Harness, cwd: string) => join(dirname(cwd), h.home);

// What no sandboxed command (agent Bash, install, gate) may read: /proc, the factory checkout's .git (it may hold
// CI_JOB_TOKEN in its remote URL), the runner's File-variable dir <project dir>.tmp, every harness home (sessions and config).
export const sandboxDenyRead = (cwd: string) => ["/proc", `${ROOT}/.git`, `${ROOT}.tmp`, ...Object.values(HARNESS_HOMES).map((h) => join(dirname(cwd), h))];
