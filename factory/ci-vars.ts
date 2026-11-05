// What every CI adapter (gitlab, local) and the worker check before a step starts.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";

// Trigger callers can set any variable, so each value must match its pattern before a step starts.
const PATTERNS: Record<string, RegExp> = {
  FACTORY_PIPELINE: /^(build|finish|dispatch)?$/, // empty only in a scheduled pipeline
  FACTORY_SCHEDULE: /^(poll|retry|watch|improve)?$/,
  FACTORY_WORK_ITEM_IID: /^([0-9]+)?$/, // empty for webhook triggers
  FACTORY_MR_IID: /^([0-9]+)?$/,
  FACTORY_BUILD_PIPELINE_ID: /^([0-9]+)?$/,
  FACTORY_SKIP_APPLY: /^1?$/,
};
// The FACTORY_* checks every CI adapter shares; more holds the CI's own variables.
export function checkVars(env: NodeJS.ProcessEnv, more: Record<string, RegExp> = {}) {
  for (const [k, re] of Object.entries({ ...more, ...PATTERNS })) if (!re.test(env[k] ?? "")) throw new Error(`${k} has a value the factory does not accept`);
  if (!env.FACTORY_PIPELINE === !env.FACTORY_SCHEDULE) throw new Error("Set exactly one of FACTORY_PIPELINE and FACTORY_SCHEDULE");
}

// GitLab, Teams and trigger secrets are File-type CI variables. Read each into memory and delete the file,
// before any agent, install or gate command runs, so the environment only holds a path to nothing.
// Only paths inside the runner's temp dir count, so no other file is ever read or deleted.
export function secretFile(env: NodeJS.ProcessEnv, key: string, secretDir: string): string | undefined {
  const raw = env[key];
  if (!raw) return undefined;
  const path = resolve(raw);
  if (!path.startsWith(resolve(secretDir) + sep) || !existsSync(path)) throw new Error(`${key} must be a File type CI variable`); // never print the value
  const value = readFileSync(path, "utf8").trim();
  rmSync(path, { force: true });
  return value;
}
