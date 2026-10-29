// The sandbox rules shared by the agent and by install and gate commands.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Absolute paths in the factory checkout. Never relative to the agent cwd, which is the target clone.
export const SETTINGS_PATH = fileURLToPath(new URL("../.claude/factory-settings.json", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

// What no sandboxed command (agent Bash, install, gate) may read: /proc, the factory checkout's .git (it may hold
// CI_JOB_TOKEN in its remote URL), the runner's File-variable dir <project dir>.tmp, and run/claude-home (sessions).
export const sandboxDenyRead = (cwd: string) => ["/proc", `${ROOT}/.git`, `${ROOT}.tmp`, join(dirname(cwd), "claude-home")];
