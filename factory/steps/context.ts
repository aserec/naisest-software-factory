// Shared parts of the CI steps: the context, the real adapters, and helpers for blocking, waiting and agent runs.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runClaude, runReviewer, wrapTicket, type ClaudeResult, type ClaudeRun } from "../agents";
import { loadRouter, loadTarget } from "../config";
import { GitLab } from "../gitlab";
import { makeJevClient, type JevClient } from "../jev";
import { addStep, loadRecord, saveRecord, type RunRecord } from "../record";
import { gitRepo } from "./repo";
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
    buildPipelineId?: number; // finish pipeline: where the build record is
    factoryProjectId?: number;
    pipelineId?: number;
    pipelineUrl: string;
  };
  startFinish(vars: Record<string, string>): Promise<void>;
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

// Claude hit a usage limit: keep the session so a later job can resume it.
export async function waiting(ctx: StepContext, step: string, sessionId: string): Promise<StepResult> {
  const { projectId, iid } = await workItem(ctx);
  save(ctx, step, { sessionId });
  await ctx.gitlab.setState(projectId, iid, "factory_waiting");
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
  const resumeSessionId = data(ctx, "prepare-patch").sessionId;
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

// GitLab, Teams and trigger secrets are File-type CI variables. Read each into memory and delete the file,
// before any agent, install or gate command runs, so the environment only holds a path to nothing.
function secretFile(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const path = env[key];
  if (!path) return undefined;
  if (!existsSync(path)) throw new Error(`${key} must be a File type CI variable`); // never print the value
  const value = readFileSync(path, "utf8").trim();
  rmSync(path, { force: true });
  return value;
}
const needSecret = (env: NodeJS.ProcessEnv, key: string) => {
  const v = secretFile(env, key);
  if (!v) throw new Error(`${key} is not set`);
  return v;
};

export function makeContext(env: NodeJS.ProcessEnv): StepContext {
  const server = need(env, "CI_SERVER_URL");
  const token = needSecret(env, "FACTORY_GITLAB_TOKEN");
  const webhook = needSecret(env, "TEAMS_WEBHOOK_URL");
  const triggerToken = secretFile(env, "FACTORY_TRIGGER_TOKEN");
  const target = loadTarget(need(env, "FACTORY_TARGET"));
  const dir = resolve(RUN_DIR, "target");
  return {
    gitlab: new GitLab(server, token),
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
    async startFinish(vars) {
      // The trigger token is only read here, by step code. It goes in the body, so errors never show it.
      if (!triggerToken) throw new Error("FACTORY_TRIGGER_TOKEN is not set");
      const body = new URLSearchParams({ token: triggerToken, ref: need(env, "CI_COMMIT_REF_NAME") });
      const all = { ...vars, FACTORY_JOB_IMAGE: target.jobImage };
      for (const [k, v] of Object.entries(all)) body.set(`variables[${k}]`, v);
      const res = await fetch(`${server}/api/v4/projects/${need(env, "CI_PROJECT_ID")}/trigger/pipeline`, { method: "POST", body });
      if (!res.ok) throw new Error(`Starting the finish pipeline failed with status ${res.status}`);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
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
      last = e;
      await ctx.sleep(Math.min(5000 * 2 ** i, 60_000));
    }
  }
  throw new Error(`Could not load the run record of build pipeline ${buildPipelineId}: ${String(last)}`);
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
    ctx.record = await loadRunRecord(ctx, dir);
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
