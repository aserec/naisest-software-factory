// The sandbox rules shared by the agent and by install and gate commands.
import { execFileSync } from "node:child_process";
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

// The clone is <ROOT>/run/target. With blockReadsOutsideWorkingDirectories, a tool that looks for config up the tree
// (browserslist in a vite build, tsconfig) gets EPERM on ROOT's files and fails. So the agent may read ROOT, but not what
// git ignores there: .env files, certificates, .cache (the dashboard db), deploy/runner. run/ is the clone's own dir.
// ponytail: a checkout without git (a factory image) gets no ROOT read, as before; add a fixed list if one needs it.
export function rootReads(root = ROOT): { allowRead: string[]; denyRead: string[] } {
  let ignored: string[];
  try {
    ignored = execFileSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1" } }).split("\n");
  } catch {
    return { allowRead: [], denyRead: [] };
  }
  const deny = ignored.filter((p) => p && p !== "run/" && !p.endsWith("node_modules/")).map((p) => join(root, p).replace(/\/$/, ""));
  return { allowRead: [root], denyRead: deny };
}
