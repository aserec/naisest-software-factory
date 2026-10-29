import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { GitLab, GITLAB_URL } from "../gitlab";
import { RUN_DIR, type RunRecord } from "../record";
import { addKnownSecrets } from "../rules";
import type { CiRunner } from "../seams";
import { sh } from "../steps/repo";


// Trigger callers can set any variable, so each value must match its pattern before a step starts.
const PATTERNS: Record<string, RegExp> = {
  CI_PROJECT_ID: /^[0-9]+$/,
  FACTORY_PIPELINE: /^(build|finish)?$/, // empty only in a scheduled pipeline
  FACTORY_SCHEDULE: /^(poll|retry|watch)?$/,
  FACTORY_WORK_ITEM_IID: /^([0-9]+)?$/, // empty for webhook triggers
  FACTORY_MR_IID: /^([0-9]+)?$/,
  FACTORY_BUILD_PIPELINE_ID: /^([0-9]+)?$/,
  FACTORY_SKIP_APPLY: /^1?$/,
};
function checkVars(env: NodeJS.ProcessEnv) {
  if (env.CI_SERVER_URL !== GITLAB_URL) throw new Error(`CI_SERVER_URL must be ${GITLAB_URL}`);
  for (const [k, re] of Object.entries(PATTERNS)) if (!re.test(env[k] ?? "")) throw new Error(`${k} has a value the factory does not accept`);
  if (!env.FACTORY_PIPELINE === !env.FACTORY_SCHEDULE) throw new Error("Set exactly one of FACTORY_PIPELINE and FACTORY_SCHEDULE");
}

// GitLab, Teams and trigger secrets are File-type CI variables. Read each into memory and delete the file,
// before any agent, install or gate command runs, so the environment only holds a path to nothing.
// Only paths inside the runner's temp dir count, so no other file is ever read or deleted.
function secretFile(env: NodeJS.ProcessEnv, key: string, secretDir: string): string | undefined {
  const raw = env[key];
  if (!raw) return undefined;
  const path = resolve(raw);
  if (!path.startsWith(resolve(secretDir) + sep) || !existsSync(path)) throw new Error(`${key} must be a File type CI variable`); // never print the value
  const value = readFileSync(path, "utf8").trim();
  rmSync(path, { force: true });
  return value;
}

const need = (env: NodeJS.ProcessEnv, key: string): string => {
  const v = env[key];
  if (!v) throw new Error(`${key} is not set`);
  return v;
};

// Steps may ask for these. The trigger token stays inside the adapter.
const SECRETS = ["FACTORY_GITLAB_TOKEN", "TEAMS_WEBHOOK_URL"];

export function makeGitLabCi(env: NodeJS.ProcessEnv, secretDir: string, fetchFn: typeof fetch = fetch): CiRunner {
  checkVars(env);
  const secrets = new Map<string, string>();
  for (const k of SECRETS) {
    const v = secretFile(env, k, secretDir);
    if (v) secrets.set(k, v);
  }
  const triggerToken = secretFile(env, "FACTORY_TRIGGER_TOKEN", secretDir);
  const token = secrets.get("FACTORY_GITLAB_TOKEN");
  // No comment, change text or pushed diff may carry any of these.
  addKnownSecrets(...secrets.values(), triggerToken);
  const gitlab = () => {
    if (!token) throw new Error("FACTORY_GITLAB_TOKEN is not set");
    return new GitLab(GITLAB_URL, token, fetchFn);
  };

  return {
    vars: {
      ticket: env.FACTORY_WORK_ITEM_IID || undefined,
      change: env.FACTORY_MR_IID || undefined,
      skipApply: env.FACTORY_SKIP_APPLY === "1",
      buildRun: env.FACTORY_BUILD_PIPELINE_ID || undefined,
      run: env.CI_PIPELINE_ID || undefined,
      runUrl: env.CI_PIPELINE_URL ?? "",
      payload: env.TRIGGER_PAYLOAD ? JSON.parse(readFileSync(env.TRIGGER_PAYLOAD, "utf8")) : undefined,
    },
    secret(name) {
      const v = secrets.get(name);
      secrets.delete(name);
      return v;
    },
    // Starts a factory pipeline through the trigger API, as the bot.
    async start(run) {
      // The trigger token goes in the body, so errors never show it.
      if (!triggerToken) throw new Error("FACTORY_TRIGGER_TOKEN is not set");
      const vars: Record<string, string | undefined> = {
        FACTORY_PIPELINE: run.kind,
        FACTORY_TARGET: need(env, "FACTORY_TARGET"),
        FACTORY_WORK_ITEM_IID: run.ticket,
        FACTORY_MR_IID: run.change,
        FACTORY_BUILD_PIPELINE_ID: run.buildRun,
        FACTORY_SKIP_APPLY: run.skipApply ? "1" : undefined,
      };
      const body = new URLSearchParams({ token: triggerToken, ref: need(env, "CI_COMMIT_REF_NAME") });
      for (const [k, v] of Object.entries(vars)) if (v !== undefined) body.set(`variables[${k}]`, v);
      const res = await fetchFn(`${GITLAB_URL}/api/v4/projects/${need(env, "CI_PROJECT_ID")}/trigger/pipeline`, { method: "POST", body });
      if (!res.ok) throw new Error(`Starting a pipeline failed with status ${res.status}`);
    },
    async buildRecord(run) {
      return (await gitlab().buildRecord(Number(need(env, "CI_PROJECT_ID")), Number(run))) as RunRecord;
    },
    // A resumed run: puts back run/ (clone, git dir, Claude session) from an earlier build run.
    async restoreRun(run) {
      await extractRun(Buffer.from(await gitlab().runArtifacts(Number(need(env, "CI_PROJECT_ID")), Number(run))), process.cwd(), env.PATH);
    },
  };
}

// Puts run/ from an artifacts zip into cwd. unzip writes into an empty temp dir, and only its run/ is copied,
// so no entry lands outside run/. The stop file goes: that pipeline stopped at the limit, this one goes on.
export async function extractRun(zip: Buffer, cwd: string, path = process.env.PATH) {
  const tmp = mkdtempSync(join(tmpdir(), "run-zip-"));
  try {
    writeFileSync(join(tmp, "artifacts.zip"), zip);
    const out = join(tmp, "out");
    const r = await sh("unzip", ["-q", "-o", join(tmp, "artifacts.zip"), `${RUN_DIR}/*`, "-d", out], tmp, { PATH: path });
    if (r.code !== 0 && r.code !== 1) throw new Error(`unzip of the run artifacts failed: ${r.out.slice(-500)}`); // 1 is warnings only
    rmSync(join(out, RUN_DIR, "stop"), { force: true });
    cpSync(join(out, RUN_DIR), join(cwd, RUN_DIR), { recursive: true, verbatimSymlinks: true });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
