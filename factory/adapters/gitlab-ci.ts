import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkVars, secretFile } from "../ci-vars";
import { GitLab, GITLAB_URL } from "../gitlab";
import { RUN_DIR, type RunRecord } from "../record";
import { addKnownSecrets } from "../rules";
import { FILE_SECRETS } from "../secrets";
import { NotFactoryRunError, type CiRunner } from "../seams";
import { sh } from "../repo";


export const need = (env: NodeJS.ProcessEnv, key: string): string => {
  const v = env[key];
  if (!v) throw new Error(`${key} is not set`);
  return v;
};

// The newest successful decision job of a build pipeline. That job's artifacts hold run/ at the end of the
// build: the record, the target clone and the Claude session.
// Only a pipeline the bot's trigger started on the factory's default branch counts: anyone who can run
// a pipeline in the factory project could otherwise upload a record that says "auto".
async function decisionJob(gitlab: GitLab, projectId: number, pipelineId: number): Promise<number> {
  const p = await gitlab.getJson(`/projects/${projectId}/pipelines/${pipelineId}`);
  const { default_branch: defaultBranch } = await gitlab.getJson(`/projects/${projectId}`);
  const bot = (await gitlab.getJson("/user")).id;
  if (p.source !== "trigger" || p.ref !== defaultBranch || p.user?.id !== bot) {
    throw new NotFactoryRunError(`Pipeline ${pipelineId} is not a factory build pipeline (source ${p.source}, ref ${p.ref}, user ${p.user?.id})`);
  }
  const jobs = await gitlab.getJson(`/projects/${projectId}/pipelines/${pipelineId}/jobs?per_page=100`);
  // A retried job leaves older ones behind. Take the newest successful one.
  const job = jobs
    .filter((j: { name: string; status: string }) => j.name === "decision" && j.status === "success")
    .sort((a: { id: number }, b: { id: number }) => b.id - a.id)[0];
  if (!job) throw new Error(`Pipeline ${pipelineId} has no successful decision job`);
  return job.id;
}

// Steps may ask for FILE_SECRETS. The trigger token stays inside the adapter.

export function makeGitLabCi(env: NodeJS.ProcessEnv, secretDir: string, fetchFn: typeof fetch = fetch): CiRunner {
  if (env.CI_SERVER_URL !== GITLAB_URL) throw new Error(`CI_SERVER_URL must be ${GITLAB_URL}`);
  checkVars(env, { CI_PROJECT_ID: /^[0-9]+$/, CI_JOB_ID: /^([0-9]+)?$/ }); // CI_JOB_ID is empty only outside CI
  const secrets = new Map<string, string>();
  for (const k of FILE_SECRETS) {
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
      job: env.CI_JOB_ID || undefined,
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
      // The pipeline has started: a body that does not parse gives no link rather than a throw.
      return ((await res.json().catch(() => ({}))) as { web_url?: string }).web_url ?? "";
    },
    async buildRecord(run) {
      const gl = gitlab();
      const project = Number(need(env, "CI_PROJECT_ID"));
      return (await gl.getJson(`/projects/${project}/jobs/${await decisionJob(gl, project, Number(run))}/artifacts/run/record.json`)) as RunRecord;
    },
    // A resumed run: puts back run/ (clone, git dir, Claude session) from an earlier build run.
    async restoreRun(run) {
      const gl = gitlab();
      const project = Number(need(env, "CI_PROJECT_ID"));
      const zip = await (await gl.call("GET", `/projects/${project}/jobs/${await decisionJob(gl, project, Number(run))}/artifacts`)).arrayBuffer();
      await extractRun(Buffer.from(zip), process.cwd(), env.PATH);
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
