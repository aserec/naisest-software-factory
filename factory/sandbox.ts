// The sandbox rules shared by the agent and by install and gate commands.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Absolute paths in the factory checkout. Never relative to the agent cwd, which is the target clone.
export const SETTINGS_PATH = fileURLToPath(new URL("../.claude/factory-settings.json", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
// Absolute, because CI steps run with a bare PATH that has no node_modules/.bin.
export const SRT = `${ROOT}/node_modules/.bin/srt`;

// Pi's home and session dir for one run, next to the clone.
export const piHome = (cwd: string) => join(dirname(cwd), "pi-home");

// What no sandboxed command (agent Bash, install, gate) may read: /proc, the factory checkout's .git (it may hold
// CI_JOB_TOKEN in its remote URL), the runner's File-variable dir <project dir>.tmp, run/claude-home and run/pi-home (sessions).
export const sandboxDenyRead = (cwd: string) => ["/proc", `${ROOT}/.git`, `${ROOT}.tmp`, join(dirname(cwd), "claude-home"), piHome(cwd)];
