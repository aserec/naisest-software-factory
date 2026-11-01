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
import { addStep, loadRecord, need, newRecord, RUN_DIR, runFacts, saveRecord, type PausableStep, type RunRecord, type StepData, type StepName } from "../record";
import { NotFactoryRunError, type Chat, type FactoryState, type JevQuestion, type CiRunner, type CodeHost, type Dashboard, type Harness, type HarnessJob, type HarnessResult, type Judge, type Notice, type Repo, type Role, type ChangeRef, type SwitchName, type Ticket, type ToolCall, type TicketRef, type Tracker } from "../seams";
import type { ControlRequest } from "../run-events";
import type { FactoryCommands, RoleChoice, Router, RouterRow, SeamsConfig, Target } from "../types";

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
  step?: string; // the CI job, set by runStep; a block saves it
  stepEvent?: string; // the ID of its step_start event, the parent of what the step sends
  dashboardStop?: boolean; // the dashboard asked this run to stop (seen by the inbox)
  snapshot?: () => Promise<Controls>; // set by takeSnapshot: the dashboard's controls for this step or poll tick
}
export type StepResult = "next" | "stop";

const POLL_MS = 30_000;
const POLL_TRIES = 120; // one hour
const RECORD_TRIES = 8; // about 4 minutes in all

export const prompt = (name: string) => readFileSync(fileURLToPath(new URL(`../../prompts/${name}.md`, import.meta.url)), "utf8");

// The facts of this run's record, as they are now.
export const facts = (ctx: StepContext) => runFacts(ctx.record);
export const save = <K extends StepName>(ctx: StepContext, step: K, d: StepData[K]) => void (ctx.record = addStep(ctx.record, step, d));
export const CONTINUE = "You stopped before you finished. Continue the same task from where you stopped.";

// The ticket of this run: from the run's variables, or from the event step's record.
export function ticketRef(ctx: StepContext): TicketRef {
  const ref: TicketRef | undefined = ctx.ci.vars.ticket ?? facts(ctx).ticket;
  if (!ref) throw new Error("This run has no ticket");
  return ref;
}

export function ticketText(ctx: StepContext): string {
  const t = ctx.record.ticket;
  if (!t) throw new Error("The run record has no triaged ticket");
  return wrapTicket(`${t.title}\n\n${t.description}`);
}

export const modelRow = (ctx: StepContext): RouterRow => need(facts(ctx).row, "triage router row");

// Installs the target's dependencies in the sandbox. Each job that runs target code needs it,
// because node_modules is not kept between jobs.
export async function install(ctx: StepContext, commands: FactoryCommands = need(facts(ctx).commands, ".factory.yml commands")): Promise<StepResult | undefined> {
  const r = await ctx.repo.run(commands.install);
  if (!r.ok) return block(ctx, `The install command failed:\n${r.output.slice(-2000)}`);
  return undefined;
}

export const person = (ctx: StepContext, ticket: Ticket) => ticket.assignees[0] ?? ctx.target.defaultApprover;

export async function notify(ctx: StepContext, kind: Notice, lines: string[], url: string) {
  const t = await ctx.tracker.ticket(ticketRef(ctx));
  await ctx.chat.notify(kind, t.title, lines, url || t.url);
}

const BUILD_JOBS = ["event", "triage", "prepare-patch", "code-review", "precommit-gate", "risk-check", "decision"];
// A ready on a blocked ticket continues the run at one of these jobs. A block anywhere else starts a new run.
export const CONTINUABLE = BUILD_JOBS.slice(2);
export const BLOCKED = "The factory stopped. A person must look at this.";
// Only the comment's last line: the reason above it can quote agent text with a run line of its own.
export const BLOCKED_RUN = /\nBlocked run: pipeline (\d+)\s*$/;

// Stop the run for a person: state, comment, assign, notice.
// continuable false: this pipeline fails, so its record never uploads and the comment names no run.
export async function block(ctx: StepContext, reason: string, continuable = CONTINUABLE.includes(ctx.step ?? "")): Promise<StepResult> {
  const ref = ticketRef(ctx);
  const t = await ctx.tracker.ticket(ref);
  save(ctx, "blocked", { reason, step: ctx.step });
  if (!t.open) await ctx.tracker.reopen(ref); // the change closed it at the merge
  await ctx.tracker.setState(ref, "blocked");
  emit(ctx, "run_end", { outcome: "blocked" });
  const line = continuable ? `\n\nBlocked run: pipeline ${ctx.ci.vars.run ?? "unknown"}` : "";
  await ctx.tracker.comment(ref, `${BLOCKED}\n\n${reason}${line}`);
  await ctx.tracker.assign(ref, person(ctx, t));
  await ctx.chat.notify("blocked", t.title, [reason], t.url);
  return "stop";
}

// The hourly retry finds the run to resume from in this comment.
export const waitingNote = (run: string | undefined) =>
  `The author agent reached its usage limit. The factory tries again every hour and continues this run.\n\nWaiting run: pipeline ${run ?? "unknown"}`;
export const WAITING_RUN = /^Waiting run: pipeline (\d+)$/m;

// The agent hit a usage limit: keep the session so a later run can resume it.
export async function waiting(ctx: StepContext, step: PausableStep, sessionId: string, extra: { commands?: FactoryCommands } = {}): Promise<StepResult> {
  const ref = ticketRef(ctx);
  save(ctx, step, { ...extra, sessionId, limit: true });
  await ctx.tracker.setState(ref, "waiting");
  await ctx.tracker.comment(ref, waitingNote(ctx.ci.vars.run));
  return "stop";
}

// The dashboard's switches and requests as one step or one poll tick sees them.
export interface Controls {
  switchOn(name: SwitchName): boolean; // a running step's switch, or new_runs before a new run starts
  resumeOn(name: SwitchName): boolean; // the poller may resume a run this switch stopped
  requests: ControlRequest[]; // the poller's resume, restart and cancelled-stop requests; readyActor's restarts
}

// The one rule for a dashboard the factory cannot reach: a running step goes on (its switch counts as on),
// no new run starts (new_runs counts as off), the poller's resumes and requests wait for the next tick,
// and readyActor keeps the actor it was given (no requests).
async function readControls(ctx: StepContext): Promise<Controls> {
  const c = await ctx.dashboard.control(ctx.target.name, ctx.record.runId).catch(() => undefined);
  if (!c) return { switchOn: (name) => name !== "new_runs", resumeOn: () => false, requests: [] };
  return { switchOn: (name) => c.switches[name], resumeOn: (name) => c.switches[name], requests: c.requests };
}

// Inside a snapshot (a step in runStep, a poll tick in poll.ts main) the dashboard is read once, at the first ask.
// Outside one each call reads it. The inbox's stop check never uses this: a stop must reach a running agent at once.
export const controls = (ctx: StepContext): Promise<Controls> => ctx.snapshot?.() ?? readControls(ctx);
export function takeSnapshot(ctx: StepContext): void {
  let read: Promise<Controls> | undefined;
  ctx.snapshot = () => (read ??= readControls(ctx));
}

export const switchOn = async (ctx: StepContext, name: SwitchName): Promise<boolean> => (await controls(ctx)).switchOn(name);

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

export async function stopped(ctx: StepContext, step: PausableStep, o: { session?: string; reason: string; change?: ChangeRef; extra?: { commands?: FactoryCommands } }): Promise<StepResult> {
  const ref = ticketRef(ctx);
  save(ctx, step, { ...o.extra, sessionId: o.session, stopped: true, switchOff: o.reason.startsWith("switch off") });
  await ctx.tracker.setState(ref, "stopped");
  await ctx.tracker.comment(ref, stoppedNote({ run: ctx.ci.vars.run ?? "unknown", step, reason: o.reason, change: o.change, buildRun: ctx.ci.vars.buildRun }));
  return "stop";
}
const PERSON_STOP = "stopped by @factory stop";
export const DASHBOARD_STOP = "stopped from the dashboard";
// Why the inbox stopped the run: the dashboard, or else a person's `@factory stop`.
export const stopReason = (ctx: StepContext) => (ctx.dashboardStop ? DASHBOARD_STOP : PERSON_STOP);

// The poller's comment when the dashboard cancelled a pipeline that did not stop in time. Such a run cannot be resumed.
const CANCEL_REASON = "Reason: pipeline cancelled from the dashboard";
export const cancelNote = (user: string) =>
  `The run was stopped from the dashboard by @${user}. The pipeline did not stop within 60 seconds, so it was cancelled. Resume is not possible. Use Restart.\n\n${CANCEL_REASON}`;
// Only the factory's own comments may be passed in.
export const isCancelNote = (body: string) => body.split("\n").includes(CANCEL_REASON);

// The factory's newest stop comment on the ticket: a stopped note, or the cancel note. A resume reads only this one:
// a person or the dashboard may have stopped the run again since an older note.
export const lastStop = async (ctx: StepContext, ref: TicketRef): Promise<string | undefined> =>
  (await ctx.tracker.comments(ref)).find((c) => c.byFactory && (STOPPED_RUN.test(c.body) || isCancelNote(c.body)))?.body;

// Starts a stopped run again, in the kind of pipeline it stopped in. A build run resumes through its event step,
// which checks the ticket and the record again. False when the note does not say enough to start it.
export async function startStopped(ctx: StepContext, ref: TicketRef, note: StoppedNote): Promise<boolean> {
  if (note.step !== "apply") {
    await ctx.ci.start({ kind: "build", ticket: ref, buildRun: note.run });
    return true;
  }
  if (!note.change || !/^\d+$/.test(note.buildRun ?? "")) return false;
  // Also a guard against a second start by the next poll. Apply sets "running" again through its run, for the dashboard.
  await ctx.tracker.setState(ref, "running");
  try {
    await ctx.ci.start({ kind: "finish", ticket: ref, change: note.change, buildRun: note.buildRun });
  } catch (e) {
    await ctx.tracker.setState(ref, "stopped"); // the next try starts it
    throw e;
  }
  return true;
}

// The ticket's inbox from the start of this run (the newest event step), so a stop posted
// between agent runs is still seen. A resumed run starts after the old stop, so it does not see it again.
// It also asks the dashboard whether a person stopped this run there.
export const inbox = (ctx: StepContext) =>
  makeInbox(ctx.tracker, ticketRef(ctx), facts(ctx).eventAt ?? new Date().toISOString(), async () => {
    const stop = (await ctx.dashboard.control(ctx.target.name, ctx.record.runId)).stop;
    if (stop) ctx.dashboardStop = true;
    return stop;
  });

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
  const f = facts(ctx);
  const resume = f.session;
  if (!resume) throw new Error("The run record has no author session to fix");
  const preview = !!f.commands?.preview;
  return agent(ctx, "author", modelRow(ctx).author, { tools: "code", resume, prompt: `${prompt("fix")}\n\n<feedback>\n${feedback}\n</feedback>`, cwd: ctx.dir, maxTurns: 30, ...(preview && { preview }) });
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
// A resumed run skips the build jobs that finished before the one that hit the limit.
function doneBeforeResume(ctx: StepContext, name: string): boolean {
  const i = BUILD_JOBS.indexOf(name);
  return i > 0 && i < BUILD_JOBS.indexOf(facts(ctx).resumeAt ?? "");
}

// A stop saved by stopped() or waiting() ends the step as "stopped" or "waiting".
function endOutcome(ctx: StepContext, result: StepResult): "next" | "stop" | "stopped" | "waiting" {
  if (result === "next") return "next";
  const p = facts(ctx).paused;
  return p?.stopped ? "stopped" : p?.limit ? "waiting" : "stop";
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
  takeSnapshot(ctx);
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
    await block(ctx, `The ${name} step failed: ${String(e).slice(0, 500)}`, false).catch(() => {});
    if (ctx.stepEvent) emit(ctx, "step_end", { outcome: "error" });
    throw e;
  } finally {
    saveRecord(ctx.record, dir); // also creates the dir
    await ctx.dashboard.flush();
    ctx.snapshot = undefined; // the next step reads the dashboard again
  }
  if (result === "stop") writeFileSync(stopFile, name);
}

// Runs main() only when the file is the script node started, not when a test imports it.
export function isMain(url: string): boolean {
  return process.argv[1] !== undefined && url === pathToFileURL(process.argv[1]).href;
}
