// Shared parts of the CI steps: the context and helpers for blocking, waiting and agent runs.
// Steps see the factory's outside tools only through the seams. makeContext (factory/compose.ts) picks the adapters.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { wrapTicket } from "../agents";
import { makeInbox } from "../inbox";
import { makeContext } from "../compose";
import { emit } from "../emit";
import { modelChoice } from "../config";
import { addStep, loadRecord, newRecord, RUN_DIR, saveRecord, type RunRecord } from "../record";
import { NotFactoryRunError, type Chat, type FactoryState, type JevQuestion, type CiRunner, type CodeHost, type Dashboard, type Harness, type HarnessJob, type HarnessResult, type Judge, type Notice, type Repo, type Role, type ChangeRef, type SwitchName, type Ticket, type ToolCall, type TicketRef, type Tracker } from "../seams";
import type { RoleChoice, Router, RouterRow, SeamsConfig, Target } from "../types";

export interface StepContext {
  tracker: Tracker;
  codeHost: CodeHost;
  ci: CiRunner;
  judge: Judge;
  chat: Chat;
  dashboard: Dashboard;
  harnesses: Record<RoleChoice["harness"], Harness>;
  seams: SeamsConfig;
  record: RunRecord;
  target: Target;
  router: Router;
  dir: string; // the target clone, cwd for agents
  repo: Repo;
  sleep(ms: number): Promise<void>;
  step?: string; // the step runStep runs
  stepEvent?: string; // the ID of its step_start event, the parent of what the step sends
}
export type StepResult = "next" | "stop";

const POLL_MS = 30_000;
const POLL_TRIES = 120; // one hour
const RECORD_TRIES = 8; // about 4 minutes in all

export const prompt = (name: string) => readFileSync(fileURLToPath(new URL(`../../prompts/${name}.md`, import.meta.url)), "utf8");

// The data of the last record step with this name.
export const data = (ctx: StepContext, step: string): any => [...ctx.record.steps].reverse().find((s) => s.step === step)?.data;
export const save = (ctx: StepContext, step: string, d: unknown) => void (ctx.record = addStep(ctx.record, step, d));
// The newest author session in the record. Fixes and resumed runs continue it.
export const session = (ctx: StepContext): string | undefined => [...ctx.record.steps].reverse().map((s: any) => s.data?.sessionId).find(Boolean);
// On a resumed run, the saved session if this job is the one that hit the limit.
export const resumeSession = (ctx: StepContext, job: string): string | undefined =>
  data(ctx, "event")?.resumeAt === job ? data(ctx, "event").sessionId : undefined;
export const CONTINUE = "You stopped before you finished. Continue the same task from where you stopped.";

// The ticket of this run: from the run's variables, or from the event step's record.
export function ticketRef(ctx: StepContext): TicketRef {
  const ref: TicketRef | undefined = ctx.ci.vars.ticket ?? data(ctx, "event")?.ticket;
  if (!ref) throw new Error("This run has no ticket");
  return ref;
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

export const person = (ctx: StepContext, ticket: Ticket) => ticket.assignees[0] ?? ctx.target.defaultApprover;

export async function notify(ctx: StepContext, kind: Notice, lines: string[], url: string) {
  const t = await ctx.tracker.ticket(ticketRef(ctx));
  await ctx.chat.notify(kind, t.title, lines, url || t.url);
}

// Stop the run for a person: state, comment, assign, notice.
export async function block(ctx: StepContext, reason: string): Promise<StepResult> {
  const ref = ticketRef(ctx);
  const t = await ctx.tracker.ticket(ref);
  save(ctx, "blocked", { reason });
  if (!t.open) await ctx.tracker.reopen(ref); // the change closed it at the merge
  await ctx.tracker.setState(ref, "blocked");
  emit(ctx, "run_end", { outcome: "blocked" });
  await ctx.tracker.comment(ref, `The factory stopped. A person must look at this.\n\n${reason}`);
  await ctx.tracker.assign(ref, person(ctx, t));
  await ctx.chat.notify("blocked", t.title, [reason], t.url);
  return "stop";
}

// The hourly retry finds the run to resume from in this comment.
export const waitingNote = (run: string | undefined) =>
  `The author agent reached its usage limit. The factory tries again every hour and continues this run.\n\nWaiting run: pipeline ${run ?? "unknown"}`;
export const WAITING_RUN = /^Waiting run: pipeline (\d+)$/m;

// The agent hit a usage limit: keep the session so a later run can resume it.
export async function waiting(ctx: StepContext, step: string, sessionId: string, extra: object = {}): Promise<StepResult> {
  const ref = ticketRef(ctx);
  save(ctx, step, { ...extra, sessionId, limit: true });
  await ctx.tracker.setState(ref, "waiting");
  await ctx.tracker.comment(ref, waitingNote(ctx.ci.vars.run));
  return "stop";
}

// Is this dashboard switch on for this target? An unreachable dashboard counts as on, so a running step goes on,
// except new_runs: no new run starts while the factory cannot see its switches.
export async function switchOn(ctx: StepContext, name: SwitchName): Promise<boolean> {
  try {
    return (await ctx.dashboard.control(ctx.target.name, ctx.record.runId)).switches[name];
  } catch {
    return name !== "new_runs";
  }
}

// A person (`@factory stop`) or a dashboard switch stopped the run. The note names the run to resume:
// `@factory resume` continues a person's stop, the poller a switch stop once the switch is on again.
export interface StoppedNote { run: string; step: string; reason: string; change?: ChangeRef; buildRun?: string }
export const stoppedNote = (n: StoppedNote) =>
  [
    n.reason.startsWith("switch off") ? "A dashboard switch stopped this run. The factory continues it when the switch is on again." : "A person stopped this run. Comment the line @factory resume to continue it.",
    "",
    `Stopped run: pipeline ${n.run}`,
    `Stopped step: ${n.step}`,
    `Reason: ${n.reason}`,
    ...(n.change ? [`Change: ${n.change}`, `Build run: ${n.buildRun ?? "unknown"}`] : []),
  ].join("\n");
export const STOPPED_RUN = /^Stopped run: pipeline (\d+)$/m;
// Reads a stopped note back. Only the factory's own comments may be passed in.
export function parseStoppedNote(body: string): StoppedNote | undefined {
  const field = (name: string) => new RegExp(`^${name}: (.+)$`, "m").exec(body)?.[1];
  const run = STOPPED_RUN.exec(body)?.[1];
  const step = field("Stopped step");
  const reason = field("Reason");
  if (!run || !step || !reason) return undefined;
  const change = field("Change");
  return { run, step, reason, ...(change ? { change, buildRun: field("Build run") } : {}) };
}

export async function stopped(ctx: StepContext, step: string, o: { session?: string; reason: string; change?: ChangeRef; extra?: object }): Promise<StepResult> {
  const ref = ticketRef(ctx);
  save(ctx, step, { ...o.extra, sessionId: o.session, stopped: true, switchOff: o.reason.startsWith("switch off") });
  await ctx.tracker.setState(ref, "stopped");
  await ctx.tracker.comment(ref, stoppedNote({ run: ctx.ci.vars.run ?? "unknown", step, reason: o.reason, change: o.change, buildRun: ctx.ci.vars.buildRun }));
  return "stop";
}
export const PERSON_STOP = "stopped by @factory stop";

// The ticket's inbox from the start of this run (the newest event step), so a stop posted
// between agent runs is still seen. A resumed run starts after the old stop, so it does not see it again.
export const inbox = (ctx: StepContext) =>
  makeInbox(ctx.tracker, ticketRef(ctx), [...ctx.record.steps].reverse().find((s) => s.step === "event")?.at ?? new Date().toISOString());

// Runs one agent job on the harness the router picked, and adds its cost and tokens to the record.
// An author run with tools gets the inbox: comments from trusted people reach it, and a stop line stops it.
export async function agent(ctx: StepContext, role: Role, choice: RoleChoice, job: Omit<HarnessJob, "role" | "model">): Promise<HarnessResult> {
  const box = role === "author" && job.tools === "code" ? inbox(ctx) : undefined;
  // Only the author's tool calls go to the dashboard. Jev and the reviewer show at step level.
  const onToolCall = role === "author" ? (c: ToolCall) => void emit(ctx, "tool_call", c, { parent: ctx.stepEvent }) : undefined;
  const r = await ctx.harnesses[choice.harness].run({ ...job, ...(box ? { inbox: box } : {}), ...(onToolCall ? { onToolCall } : {}), role, model: modelChoice(choice, ctx.seams) });
  emit(ctx, "usage", { role, model: choice.model, input: r.tokens.input, output: r.tokens.output, cacheRead: r.tokens.cacheRead, cacheWrite: r.tokens.cacheWrite, costUsd: r.costUsd, contextTokens: r.contextTokens });
  const t = ctx.record.tokens ?? { input: 0, output: 0 };
  ctx.record = {
    ...ctx.record,
    costUsd: ctx.record.costUsd + r.costUsd,
    tokens: { input: t.input + r.tokens.input, output: t.output + r.tokens.output },
    // The author's last answer says what changed. The result comment shows it.
    ...(role === "author" && r.ok ? { summary: r.text } : {}),
  };
  return r;
}

// Resume the author session with feedback from the reviewer or the gate.
export function fix(ctx: StepContext, feedback: string): Promise<HarnessResult> {
  const resume = session(ctx);
  if (!resume) throw new Error("The run record has no author session to fix");
  return agent(ctx, "author", modelRow(ctx).author, { tools: "code", resume, prompt: `${prompt("fix")}\n\n<feedback>\n${feedback}\n</feedback>`, cwd: ctx.dir, maxTurns: 30 });
}

// Polls a status for up to an hour. Still "running" after that counts as not done.
export async function waitFor<S extends string>(ctx: StepContext, status: () => Promise<S | "running">): Promise<S | "running"> {
  for (let i = 0; i < POLL_TRIES; i++) {
    const s = await status();
    if (s !== "running") return s;
    await ctx.sleep(POLL_MS);
  }
  return "running" as const;
}

// The record from run/, or for the first finish job the one the build run saved. That run's
// decision job may still be uploading it when finish starts, so retry for a few minutes.
async function loadRunRecord(ctx: StepContext, dir: string): Promise<RunRecord> {
  if (existsSync(join(dir, "record.json"))) return loadRecord(dir);
  const { buildRun } = ctx.ci.vars;
  if (!buildRun) return newRecord();
  let last: unknown;
  for (let i = 0; i < RECORD_TRIES; i++) {
    try {
      return await ctx.ci.buildRecord(buildRun);
    } catch (e) {
      // decision starts finish from inside its own job, so its record may not be there yet: wait.
      // A failed provenance check fails at once.
      if (e instanceof NotFactoryRunError) throw e;
      last = e;
      await ctx.sleep(Math.min(5000 * 2 ** i, 60_000));
    }
  }
  throw new Error(`Could not load the run record of build pipeline ${buildRun}: ${String(last)}`);
}

const TRANSIENT = /status 5\d\d|fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN/;
const BUILD_JOBS = ["event", "triage", "prepare-patch", "code-review", "precommit-gate", "risk-check", "decision"];
// A resumed run skips the build jobs that finished before the one that hit the limit.
function doneBeforeResume(ctx: StepContext, name: string): boolean {
  const i = BUILD_JOBS.indexOf(name);
  return i > 0 && i < BUILD_JOBS.indexOf(data(ctx, "event")?.resumeAt);
}

// A stop saved by stopped() or waiting() ends the step as "stopped" or "waiting".
function endOutcome(ctx: StepContext, result: StepResult): "next" | "stop" | "stopped" | "waiting" {
  if (result === "next") return "next";
  const last = ctx.record.steps.at(-1)?.data as { stopped?: boolean; limit?: boolean } | undefined;
  return last?.stopped ? "stopped" : last?.limit ? "waiting" : "stop";
}

// Sends a label_change for every state the steps set and a jev_answer for every Jev answer, so no step has to.
// The dashboard names states factory_<state>, as the ticket labels do, and picks the run's buttons by the last one.
const WATCHED = Symbol("watched");
function watch(ctx: StepContext): void {
  const { tracker, judge } = ctx;
  if (WATCHED in tracker) return; // a test may run every step on one context
  ctx.tracker = Object.assign(Object.create(tracker) as Tracker, {
    [WATCHED]: true,
    setState: async (ref: TicketRef, state: FactoryState) => {
      await tracker.setState(ref, state);
      emit(ctx, "label_change", { to: `factory_${state}` });
    },
  });
  ctx.judge = Object.assign(Object.create(judge) as Judge, {
    ask: async (state: unknown, questions: JevQuestion[]) => {
      const answers = await judge.ask(state, questions);
      for (const a of answers) emit(ctx, "jev_answer", { question: questions.find((q) => q.id === a.id)?.text ?? a.id, answer: String(a.value), confidence: String(a.confidence) });
      return answers;
    },
  });
}

// The CI job body: skip if an earlier job stopped the run, run the step, save the record.
// A "stop" is a normal end. Only unexpected errors fail the job, and they block the ticket first.
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
  watch(ctx);
  ctx.step = name;
  ctx.stepEvent = undefined;
  let result: StepResult;
  try {
    try {
      ctx.record = await loadRunRecord(ctx, dir);
    } catch (e) {
      // A resume whose record cannot be read now (a server 5xx or a network error) waits for the next hourly retry.
      // Anything else (forged, 404, no decision job, a bad record) will not get better: block, so a person hears.
      if (name !== "event" || !ctx.ci.vars.buildRun || !TRANSIENT.test(String(e))) throw e;
      save(ctx, "event", { start: false, reason: "record-unavailable", error: String(e).slice(0, 500) });
      mkdirSync(dir, { recursive: true });
      writeFileSync(stopFile, name);
      return;
    }
    if (doneBeforeResume(ctx, name)) {
      console.log(`Skipping ${name}: it finished before the run was resumed.`);
      return;
    }
    // The event step sends its own start once it knows the run goes on, so a declined start or resume sends nothing to the run.
    if (name !== "event") ctx.stepEvent = emit(ctx, "step_start", {});
    result = await run(ctx);
    if (ctx.stepEvent) emit(ctx, "step_end", { outcome: endOutcome(ctx, result) });
  } catch (e) {
    emit(ctx, "error", { message: String(e).slice(0, 500) });
    // Do not leave the ticket stuck in a running state. block() needs a ticket; without one it throws and we go on.
    await block(ctx, `The ${name} step failed: ${String(e).slice(0, 500)}`).catch(() => {});
    if (ctx.stepEvent) emit(ctx, "step_end", { outcome: "error" });
    throw e;
  } finally {
    saveRecord(ctx.record, dir); // also creates the dir
    await ctx.dashboard.flush();
  }
  if (result === "stop") writeFileSync(stopFile, name);
}

// Runs main() only when the file is the script node started, not when a test imports it.
export function isMain(url: string): boolean {
  return process.argv[1] !== undefined && url === pathToFileURL(process.argv[1]).href;
}
