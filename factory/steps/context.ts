// Shared parts of the CI steps: the context, the real adapters, and helpers for blocking, waiting and agent runs.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runClaude, runReviewer, wrapTicket, type ClaudeResult, type ClaudeRun } from "../agents";
import { loadRouter, loadTarget } from "../config";
import { GitLab } from "../gitlab";
import { makeJevClient, type JevClient } from "../jev";
import { addStep, loadRecord, saveRecord, type RunRecord } from "../record";
import { buildCard, sendCard, type CardKind } from "../teams";
import type { Router, RouterRow, Target } from "../types";

// The target clone. Only step code touches GitLab; agents work here with no tokens.
export interface Repo {
  clone(ref: string): Promise<void>;
  // All changes against base, committed or not, new files included.
  diff(base: string): Promise<{ text: string; numstat: string }>;
  // A .factory.yml command, with a clean environment.
  run(cmd: string): Promise<{ ok: boolean; output: string }>;
  commitAndPush(branch: string, message: string): Promise<void>;
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
  env: { payload?: unknown; workItemIid?: number; mrIid?: number; pipelineUrl: string };
  startFinish(vars: Record<string, string>): Promise<void>;
  sleep(ms: number): Promise<void>;
}
export type StepResult = "next" | "stop";

export const RUN_DIR = "run";
const STOP_FILE = join(RUN_DIR, "stop");
const POLL_MS = 30_000;
const POLL_TRIES = 120; // one hour

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

function sh(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  return new Promise((done, fail) => {
    const p = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", fail);
    p.on("close", (code) => done({ code, out }));
  });
}

const cleanEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ PATH: env.PATH, HOME: env.HOME, LANG: env.LANG });

export function gitRepo(dir: string, url: string, token: string, env: NodeJS.ProcessEnv): Repo {
  // The token goes in a header through env, so it is never written to .git/config where the agent could read it.
  const auth = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString("base64")}` };
  const git = async (args: string[], withAuth = false, cwd = dir) => {
    // Hooks off: the agent may have written some into the clone.
    const r = await sh("git", ["-c", "core.hooksPath=/dev/null", ...args], cwd, { ...cleanEnv(env), ...(withAuth ? auth : {}) });
    if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.out.slice(-500)}`);
    return r.out;
  };
  return {
    async clone(ref) {
      if (existsSync(dir)) return;
      await git(["clone", "--depth", "1", "--branch", ref, url, dir], true, ".");
      appendFileSync(join(dir, ".git/info/exclude"), "\nrun/\n"); // run/test-changes.md is a note, not part of the change
    },
    async diff(base) {
      await git(["add", "-A", "-N"]);
      return { text: await git(["diff", base]), numstat: await git(["diff", "--numstat", "-z", "-M", base]) };
    },
    async run(cmd) {
      const r = await sh("sh", ["-c", cmd], dir, cleanEnv(env));
      return { ok: r.code === 0, output: r.out };
    },
    async commitAndPush(branch, message) {
      await git(["checkout", "-B", branch]);
      await git(["add", "-A"]);
      await git(["-c", "user.name=Software Factory", "-c", "user.email=factory@noreply.invalid", "commit", "--no-verify", "-m", message]);
      await git(["push", "origin", `HEAD:refs/heads/${branch}`], true);
    },
    readFile: (path) => (existsSync(join(dir, path)) ? readFileSync(join(dir, path), "utf8") : undefined),
  };
}

function need(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`${key} is not set`);
  return v;
}
const num = (v: string | undefined) => (v ? Number(v) : undefined);

export function makeContext(env: NodeJS.ProcessEnv): StepContext {
  const server = need(env, "CI_SERVER_URL");
  const token = need(env, "FACTORY_GITLAB_TOKEN");
  const webhook = need(env, "TEAMS_WEBHOOK_URL");
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
    repo: gitRepo(dir, `${server}/${target.projectPath}.git`, token, env),
    env: {
      payload: env.TRIGGER_PAYLOAD ? JSON.parse(readFileSync(env.TRIGGER_PAYLOAD, "utf8")) : undefined,
      workItemIid: num(env.FACTORY_WORK_ITEM_IID),
      mrIid: num(env.FACTORY_MR_IID),
      pipelineUrl: env.CI_PIPELINE_URL ?? "",
    },
    async startFinish(vars) {
      // The trigger token is only read here, by step code. It goes in the body, so errors never show it.
      const body = new URLSearchParams({ token: need(env, "FACTORY_TRIGGER_TOKEN"), ref: need(env, "CI_COMMIT_REF_NAME") });
      const all = { ...vars, FACTORY_BUILD_PIPELINE_ID: need(env, "CI_PIPELINE_ID"), FACTORY_JOB_IMAGE: target.jobImage };
      for (const [k, v] of Object.entries(all)) body.set(`variables[${k}]`, v);
      const res = await fetch(`${server}/api/v4/projects/${need(env, "CI_PROJECT_ID")}/trigger/pipeline`, { method: "POST", body });
      if (!res.ok) throw new Error(`Starting the finish pipeline failed with status ${res.status}`);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

async function loadRunRecord(ctx: StepContext, env: NodeJS.ProcessEnv): Promise<RunRecord> {
  if (existsSync(join(RUN_DIR, "record.json"))) return loadRecord(RUN_DIR);
  // The first finish job starts with the record of the build pipeline that started it.
  if (env.FACTORY_BUILD_PIPELINE_ID) return (await ctx.gitlab.buildRecord(Number(need(env, "CI_PROJECT_ID")), Number(env.FACTORY_BUILD_PIPELINE_ID))) as RunRecord;
  return newRecord();
}

// The CI job body: skip if an earlier job stopped the run, run the step, save the record.
// A "stop" is a normal end. Only unexpected errors fail the job.
export async function runStep(name: string, run: (ctx: StepContext) => Promise<StepResult>, env = process.env): Promise<void> {
  if (existsSync(STOP_FILE)) {
    console.log(`Skipping ${name}: the run stopped at ${readFileSync(STOP_FILE, "utf8")}.`);
    return;
  }
  const ctx = makeContext(env);
  ctx.record = await loadRunRecord(ctx, env);
  let result: StepResult;
  try {
    result = await run(ctx);
  } catch (e) {
    // Do not leave the work item stuck in factory_running. The original error still fails the job.
    if (ctx.record.workItem) await block(ctx, `The ${name} step failed: ${String(e).slice(0, 500)}`).catch(() => {});
    throw e;
  } finally {
    saveRecord(ctx.record, RUN_DIR); // also creates run/
  }
  if (result === "stop") writeFileSync(STOP_FILE, name);
}

// Runs main() only when the file is the script node started, not when a test imports it.
export function isMain(url: string): boolean {
  return process.argv[1] !== undefined && url === pathToFileURL(process.argv[1]).href;
}
