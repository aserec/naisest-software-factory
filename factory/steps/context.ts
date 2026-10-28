// Shared parts of the CI steps: the context, the real adapters, and helpers for blocking, waiting and agent runs.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runClaude, runReviewer, wrapTicket, type ClaudeResult, type ClaudeRun } from "../agents";
import { loadRouter, loadTarget } from "../config";
import { GitLab, NotFactoryPipelineError } from "../gitlab";
import { makeJevClient, type JevClient } from "../jev";
import { addStep, loadRecord, saveRecord, type RunRecord } from "../record";
import { addKnownSecrets } from "../rules";
import { FACTORY_ROOT, gitRepo, sh } from "./repo";
import { buildCard, sendCard, type CardKind } from "../teams";
import type { Router, RouterRow, Target } from "../types";

// The target clone. Only step code touches GitLab; agents work here with no tokens.
export interface Repo {
  clone(ref: string): Promise<void>;
  // All changes in the clone against the base commit, new files included.
  diff(): Promise<{ text: string; numstat: string }>;
  // A .factory.yml command, inside the sandbox.
  run(cmd: string): Promise<{ ok: boolean; output: string }>;
  // Commits the clone's files on top of the base and force-pushes the branch. Returns the new sha.
  commitAndPush(branch: string, message: string): Promise<string>;
  readFile(path: string): string | undefined;
}

export interface StepContext {
  gitlab: GitLab;
  jev: JevClient;
  teams: (card: object) => Promise<void>;
  agents: { claude: typeof runClaude; review: typeof runReviewer };
  record: RunRecord;
  target: Target;
  router: Router;
  dir: string; // the target clone, cwd for agents
  repo: Repo;
  env: {
    payload?: unknown;
    workItemIid?: number;
    mrIid?: number;
    skipApply?: boolean; // a person merged by hand
    buildPipelineId?: number; // finish pipeline or resumed run: where the build record is
    factoryProjectId?: number;
    pipelineId?: number;
    pipelineUrl: string;
  };
  // Starts a factory pipeline through the trigger API, as the bot.
  startPipeline(vars: Record<string, string>): Promise<void>;
  // A resumed run: puts back run/ (clone, git dir, Claude session) from an earlier build pipeline.
  restoreRun(pipelineId: number): Promise<void>;
  sleep(ms: number): Promise<void>;
}
export type StepResult = "next" | "stop";

export const RUN_DIR = "run";
const POLL_MS = 30_000;
const POLL_TRIES = 120; // one hour
const RECORD_TRIES = 8; // about 4 minutes in all

export const prompt = (name: string) => readFileSync(fileURLToPath(new URL(`../../prompts/${name}.md`, import.meta.url)), "utf8");

export function newRecord(): RunRecord {
  return { workItem: "", startedAt: new Date().toISOString(), steps: [], models: {}, rounds: { review: 0, gate: 0 }, costUsd: 0 };
}

// The data of the last record step with this name.
export const data = (ctx: StepContext, step: string): any => [...ctx.record.steps].reverse().find((s) => s.step === step)?.data;
export const save = (ctx: StepContext, step: string, d: unknown) => void (ctx.record = addStep(ctx.record, step, d));
// The newest author session in the record. Fixes and resumed runs continue it.
export const session = (ctx: StepContext): string | undefined => [...ctx.record.steps].reverse().map((s: any) => s.data?.sessionId).find(Boolean);
// On a resumed run, the saved session if this job is the one that hit the limit.
export const resumeSession = (ctx: StepContext, job: string): string | undefined =>
  data(ctx, "event")?.resumeAt === job ? data(ctx, "event").sessionId : undefined;
export const CONTINUE = "You stopped because of a usage limit. Continue the same task from where you stopped.";

export async function workItem(ctx: StepContext) {
  const iid: number | undefined = ctx.env.workItemIid ?? data(ctx, "event")?.workItemIid;
  if (!iid) throw new Error("This run has no work item");
  const p = await ctx.gitlab.getProject(ctx.target.projectPath);
  return { projectId: p.id, defaultBranch: p.defaultBranch, iid };
}

export function ticketText(ctx: StepContext): string {
  const t = ctx.record.ticket;
  if (!t) throw new Error("The run record has no triaged ticket");
  return wrapTicket(`${t.title}\n\n${t.description}`);
}

export const modelRow = (ctx: StepContext): RouterRow => data(ctx, "triage").row;

// Installs the target's dependencies in the sandbox. Each job that runs target code needs it,
// because node_modules is not kept between jobs.
export async function install(ctx: StepContext, commands = data(ctx, "prepare-patch").commands): Promise<StepResult | undefined> {
  const r = await ctx.repo.run(commands.install);
  if (!r.ok) return block(ctx, `The install command failed:\n${r.output.slice(-2000)}`);
  return undefined;
}

export async function person(ctx: StepContext, assigneeIds: number[]): Promise<number> {
  return assigneeIds[0] ?? ctx.gitlab.userId(ctx.target.defaultApprover);
}

export async function card(ctx: StepContext, kind: CardKind, lines: string[], url: string) {
  const { projectId, iid } = await workItem(ctx);
  const item = await ctx.gitlab.getWorkItem(projectId, iid);
  await ctx.teams(buildCard(kind, item.title, lines, url || item.webUrl));
}

// Stop the run for a person: label, comment, assign, card.
export async function block(ctx: StepContext, reason: string): Promise<StepResult> {
  const { projectId, iid } = await workItem(ctx);
  const item = await ctx.gitlab.getWorkItem(projectId, iid);
  save(ctx, "blocked", { reason });
  if (item.state === "closed") await ctx.gitlab.reopenWorkItem(projectId, iid); // "Closes #iid" closed it at the merge
  await ctx.gitlab.setState(projectId, iid, "factory_blocked");
  await ctx.gitlab.comment(projectId, iid, `The factory stopped. A person must look at this.\n\n${reason}`);
  await ctx.gitlab.assignWorkItem(projectId, iid, await person(ctx, item.assigneeIds));
  await ctx.teams(buildCard("blocked", item.title, [reason], item.webUrl));
  return "stop";
}

// The hourly retry finds the pipeline to resume from in this comment.
export const waitingNote = (pipelineId: number | undefined) =>
  `Claude reached its usage limit. The factory tries again every hour and continues this run.\n\nWaiting run: pipeline ${pipelineId ?? "unknown"}`;
export const WAITING_RUN = /^Waiting run: pipeline (\d+)$/m;

// Claude hit a usage limit: keep the session so a later pipeline can resume it.
export async function waiting(ctx: StepContext, step: string, sessionId: string, extra: object = {}): Promise<StepResult> {
  const { projectId, iid } = await workItem(ctx);
  save(ctx, step, { ...extra, sessionId, limit: true });
  await ctx.gitlab.setState(projectId, iid, "factory_waiting");
  await ctx.gitlab.comment(projectId, iid, waitingNote(ctx.env.pipelineId));
  return "stop";
}

export async function claude(ctx: StepContext, run: ClaudeRun): Promise<ClaudeResult> {
  const r = await ctx.agents.claude(run);
  ctx.record = { ...ctx.record, costUsd: ctx.record.costUsd + r.costUsd };
  return r;
}

// Resume the author session with feedback from the reviewer or the gate.
export function fix(ctx: StepContext, feedback: string): Promise<ClaudeResult> {
  const row = modelRow(ctx);
  const resumeSessionId = session(ctx);
  if (!resumeSessionId) throw new Error("The run record has no author session to fix");
  return claude(ctx, { prompt: `${prompt("fix")}\n\n<feedback>\n${feedback}\n</feedback>`, model: row.author, effort: row.effort, maxTurns: 30, cwd: ctx.dir, resumeSessionId });
}

// Polls a pipeline status for up to an hour. Still "running" after that counts as not green.
export async function waitFor(ctx: StepContext, status: () => Promise<"success" | "failed" | "running">) {
  for (let i = 0; i < POLL_TRIES; i++) {
    const s = await status();
    if (s !== "running") return s;
    await ctx.sleep(POLL_MS);
  }
  return "running" as const;
}

// --- Real adapters ---

function need(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`${key} is not set`);
  return v;
}
const num = (v: string | undefined) => (v ? Number(v) : undefined);

export const GITLAB_URL = "https://gitlab.example.com";
// The runner keeps File-type variables in <project dir>.tmp. Taken from this file's place, not from env.
const SECRET_DIR = `${FACTORY_ROOT}.tmp`;

// Trigger callers can set any variable, so each value must match its pattern before a step starts.
const PATTERNS: Record<string, RegExp> = {
  CI_PROJECT_ID: /^[0-9]+$/,
  FACTORY_PIPELINE: /^(build|finish)?$/, // empty only in a scheduled pipeline
  FACTORY_SCHEDULE: /^(poll|retry)?$/,
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
const needSecret = (env: NodeJS.ProcessEnv, key: string, secretDir: string) => {
  const v = secretFile(env, key, secretDir);
  if (!v) throw new Error(`${key} is not set`);
  return v;
};

export function makeContext(env: NodeJS.ProcessEnv, secretDir = SECRET_DIR): StepContext {
  checkVars(env);
  const server = GITLAB_URL;
  const token = needSecret(env, "FACTORY_GITLAB_TOKEN", secretDir);
  const webhook = needSecret(env, "TEAMS_WEBHOOK_URL", secretDir);
  const triggerToken = secretFile(env, "FACTORY_TRIGGER_TOKEN", secretDir);
  // No comment, MR text or pushed diff may carry any of these.
  addKnownSecrets(token, webhook, triggerToken, env.CLAUDE_CODE_OAUTH_TOKEN, env.TENSORX_API_KEY, env.BERGET_API_KEY);
  // FACTORY_TARGET comes from a trigger variable: allow only a name with its own targets/<name>.yml.
  const name = need(env, "FACTORY_TARGET");
  if (!/^[a-z0-9_-]+$/.test(name) || !existsSync(fileURLToPath(new URL(`../../targets/${name}.yml`, import.meta.url)))) throw new Error(`Unknown FACTORY_TARGET ${name}`);
  const target = loadTarget(name);
  if (env.CI_JOB_IMAGE && env.CI_JOB_IMAGE !== target.jobImage) throw new Error(`The job runs image ${env.CI_JOB_IMAGE}, but target ${name} names ${target.jobImage}`);
  const dir = resolve(RUN_DIR, "target");
  const gitlab = new GitLab(server, token);
  return {
    gitlab,
    jev: makeJevClient(env),
    teams: (c) => sendCard(webhook, c),
    agents: { claude: runClaude, review: runReviewer },
    record: newRecord(),
    target,
    router: loadRouter(),
    dir,
    repo: gitRepo(dir, `${dir}.git`, `${server}/${target.projectPath}.git`, token, env),
    env: {
      payload: env.TRIGGER_PAYLOAD ? JSON.parse(readFileSync(env.TRIGGER_PAYLOAD, "utf8")) : undefined,
      workItemIid: num(env.FACTORY_WORK_ITEM_IID),
      mrIid: num(env.FACTORY_MR_IID),
      skipApply: env.FACTORY_SKIP_APPLY === "1",
      buildPipelineId: num(env.FACTORY_BUILD_PIPELINE_ID),
      factoryProjectId: num(env.CI_PROJECT_ID),
      pipelineId: num(env.CI_PIPELINE_ID),
      pipelineUrl: env.CI_PIPELINE_URL ?? "",
    },
    async startPipeline(vars) {
      // The trigger token is only read here, by step code. It goes in the body, so errors never show it.
      if (!triggerToken) throw new Error("FACTORY_TRIGGER_TOKEN is not set");
      const body = new URLSearchParams({ token: triggerToken, ref: need(env, "CI_COMMIT_REF_NAME") });
      for (const [k, v] of Object.entries(vars)) body.set(`variables[${k}]`, v);
      const res = await fetch(`${server}/api/v4/projects/${need(env, "CI_PROJECT_ID")}/trigger/pipeline`, { method: "POST", body });
      if (!res.ok) throw new Error(`Starting a pipeline failed with status ${res.status}`);
    },
    async restoreRun(pipelineId) {
      await extractRun(Buffer.from(await gitlab.runArtifacts(Number(need(env, "CI_PROJECT_ID")), pipelineId)), process.cwd(), env.PATH);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
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

// The record from run/, or for the first finish job the one the build pipeline saved. That pipeline's
// decision job may still be uploading it when finish starts, so retry for a few minutes.
async function loadRunRecord(ctx: StepContext, dir: string): Promise<RunRecord> {
  if (existsSync(join(dir, "record.json"))) return loadRecord(dir);
  const { buildPipelineId, factoryProjectId } = ctx.env;
  if (!buildPipelineId) return newRecord();
  if (!factoryProjectId) throw new Error("CI_PROJECT_ID is not set");
  let last: unknown;
  for (let i = 0; i < RECORD_TRIES; i++) {
    try {
      return (await ctx.gitlab.buildRecord(factoryProjectId, buildPipelineId)) as RunRecord;
    } catch (e) {
      // decision starts finish from inside its own job, so its record may not be there yet: wait.
      // A failed provenance check fails at once.
      if (e instanceof NotFactoryPipelineError) throw e;
      last = e;
      await ctx.sleep(Math.min(5000 * 2 ** i, 60_000));
    }
  }
  throw new Error(`Could not load the run record of build pipeline ${buildPipelineId}: ${String(last)}`);
}

const TRANSIENT = /status 5\d\d|fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN/;
const BUILD_JOBS = ["event", "triage", "prepare-patch", "code-review", "precommit-gate", "risk-check", "decision"];
// A resumed run skips the build jobs that finished before the one that hit the limit.
function doneBeforeResume(ctx: StepContext, name: string): boolean {
  const i = BUILD_JOBS.indexOf(name);
  return i > 0 && i < BUILD_JOBS.indexOf(data(ctx, "event")?.resumeAt);
}

// The CI job body: skip if an earlier job stopped the run, run the step, save the record.
// A "stop" is a normal end. Only unexpected errors fail the job, and they block the work item first.
export async function runStep(
  name: string,
  run: (ctx: StepContext) => Promise<StepResult>,
  opts: { env?: NodeJS.ProcessEnv; make?: (env: NodeJS.ProcessEnv) => StepContext; dir?: string } = {},
): Promise<void> {
  const dir = opts.dir ?? RUN_DIR;
  const stopFile = join(dir, "stop");
  if (existsSync(stopFile)) {
    console.log(`Skipping ${name}: the run stopped at ${readFileSync(stopFile, "utf8")}.`);
    return;
  }
  const ctx = (opts.make ?? makeContext)(opts.env ?? process.env);
  let result: StepResult;
  try {
    try {
      ctx.record = await loadRunRecord(ctx, dir);
    } catch (e) {
      // A resume whose record cannot be read now (GitLab 5xx or a network error) waits for the next hourly retry.
      // Anything else (forged, 404, no decision job, a bad record) will not get better: block, so a person hears.
      if (name !== "event" || !ctx.env.buildPipelineId || !TRANSIENT.test(String(e))) throw e;
      save(ctx, "event", { start: false, reason: "record-unavailable", error: String(e).slice(0, 500) });
      mkdirSync(dir, { recursive: true });
      writeFileSync(stopFile, name);
      return;
    }
    if (doneBeforeResume(ctx, name)) {
      console.log(`Skipping ${name}: it finished before the run was resumed.`);
      return;
    }
    result = await run(ctx);
  } catch (e) {
    // Do not leave the work item stuck in a running state. block() needs a work item; without one it throws and we go on.
    await block(ctx, `The ${name} step failed: ${String(e).slice(0, 500)}`).catch(() => {});
    throw e;
  } finally {
    saveRecord(ctx.record, dir); // also creates the dir
  }
  if (result === "stop") writeFileSync(stopFile, name);
}

// Runs main() only when the file is the script node started, not when a test imports it.
export function isMain(url: string): boolean {
  return process.argv[1] !== undefined && url === pathToFileURL(process.argv[1]).href;
}
