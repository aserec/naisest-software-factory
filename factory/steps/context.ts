// Shared parts of the CI steps: the context, the dashboard controls and agent runs. Pausing a run lives in run.ts.
// Steps see the factory's outside tools only through the seams. makeContext (factory/compose.ts) picks the adapters.
import { errText } from "../errors";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { wrapTicket } from "../agents";
import { makeInbox } from "../inbox";
import { conversation, later, md } from "../conversation";
import { makeContext } from "../compose";
import { emit } from "../emit";
import { localPath, localSection } from "../local-instructions";
import { DEFAULT_PORT, withPort } from "../factory-file";
import { writeShooter } from "../proof";
import { modelChoice } from "../config";
import { addStep, loadRecord, need, newRecord, RUN_DIR, runFacts, saveRecord, type PausableStep, type RunRecord, type StepData, type StepName } from "../record";
import { NotFactoryRunError, type Chat, type FactoryState, type JevQuestion, type CiRunner, type ChangeRef, type CodeHost, type Dashboard, type Harness, type HarnessJob, type HarnessResult, type Judge, type Notice, type Repo, type Role, type SwitchName, type Ticket, type ToolCall, type TicketRef, type Tracker } from "../seams";
import { LANGUAGES, MAX_FIELD, OFF_UNTIL_SET, type ControlRequest, type TargetSettings } from "../run-events";
import { DEFAULT_THRESHOLDS, checkThresholds, type Thresholds } from "../thresholds";
import type { HarnessName } from "../harnesses";
import type { FactoryCommands, RoleChoice, Router, RouterRow, SeamsConfig, Target } from "../types";
import { applyOutcome, block, closedByPerson, doneBeforeResume, type Closed } from "./run";
import { withStep, type EndKind } from "./with-step";

export interface StepContext {
  tracker: Tracker;
  codeHost: CodeHost;
  ci: CiRunner;
  judge: Judge;
  chat: Chat;
  dashboard: Dashboard;
  harnesses: Record<HarnessName, Harness>;
  seams: SeamsConfig;
  record: RunRecord;
  target: Target;
  router: Router;
  dir: string; // the target clone, cwd for agents
  repo: Repo;
  sleep(ms: number): Promise<void>;
  step?: string; // the step now running, set by withStep
  job?: string; // the CI job, set by runStep; a block saves it, since a step can run inside another
  stepEvent?: string; // the ID of its step_start event, the parent of what the step sends (withStep sets both)
  dashboardStop?: boolean; // the dashboard asked this run to stop (seen by the inbox)
  snapshot?: () => Promise<Controls>; // set by takeSnapshot: the dashboard's controls for this step or poll tick
}
// GLOSSARY.md: Step outcome. A step returns it; applyOutcome (run.ts) makes the writes a pause or a block needs.
export type StepOutcome =
  | { kind: "next" }
  | { kind: "ended" } // the step ended the run itself: it asked a person, closed a duplicate or started nothing
  | { kind: "blocked"; reason: string; continuable?: boolean }
  | { kind: "waiting"; step: PausableStep; session: string; commands?: FactoryCommands }
  | { kind: "stopped"; step: PausableStep; session?: string; reason: string; change?: ChangeRef; commands?: FactoryCommands }
  | { kind: "closed"; ref: TicketRef; closed: Closed };
export const NEXT: StepOutcome = { kind: "next" };
export const ENDED: StepOutcome = { kind: "ended" };

const POLL_MS = 30_000;
const POLL_TRIES = 120; // one hour
const RECORD_TRIES = 8; // about 4 minutes in all

export const prompt = (name: string) => readFileSync(fileURLToPath(new URL(`../../prompts/${name}.md`, import.meta.url)), "utf8");

// The facts of this run's record, as they are now.
export const facts = (ctx: StepContext) => {
  const f = runFacts(ctx.record);
  return { ...f, commands: f.commands && withPort(f.commands, runPort()) };
};
// The port {port} in the .factory.yml commands stands for: local-factory.sh gives each slot its own.
export const runPort = () => process.env.FACTORY_PORT || DEFAULT_PORT;
export const save = <K extends StepName>(ctx: StepContext, step: K, d: StepData[K]) => void (ctx.record = addStep(ctx.record, step, d));
export const CONTINUE = "You stopped before you finished. Continue the same task from where you stopped.";

// The ticket of this run: from the run's variables, or from the event step's record.
export function ticketRef(ctx: StepContext): TicketRef {
  const ref: TicketRef | undefined = ctx.ci.vars.ticket ?? facts(ctx).ticket;
  if (!ref) throw new Error("This run has no ticket");
  return ref;
}

export async function ticketText(ctx: StepContext): Promise<string> {
  const t = ctx.record.ticket;
  if (!t) throw new Error("The run record has no triaged ticket");
  // Every agent prompt that writes for people holds the ticket, so the target's language rides along here.
  return wrapTicket(`${t.title}\n\n${t.description}`) + (await languageLine(ctx));
}

// The target's language as a prompt line, starting with a blank line. The Settings page's language wins over the target file's.
// English gives "": the prompts are English.
export async function languageLine(ctx: StepContext): Promise<string> {
  const code = (await controls(ctx)).settings?.language;
  const name = code ? LANGUAGES[code] : ctx.target.language;
  return name && name !== LANGUAGES.en ? `\n\nWrite every text a person reads in ${name}: tickets, comments, questions, findings, notes for the dashboard, the commit message and the pull request. Keep code, identifiers and the conventional commit type in English.` : "";
}

export const modelRow = (ctx: StepContext): RouterRow => need(facts(ctx).row, "triage router row");

// Installs the target's dependencies in the sandbox. Each job that runs target code needs it,
// because node_modules is not kept between jobs.
export async function install(ctx: StepContext, commands: FactoryCommands = need(facts(ctx).commands, ".factory.yml commands")): Promise<StepOutcome | undefined> {
  const r = await ctx.repo.run(commands.install);
  if (!r.ok) return block(`The install command failed:\n${r.output.slice(-2000)}`);
  return undefined;
}

export const person = (ctx: StepContext, ticket: Ticket) => ticket.assignees[0] ?? ctx.target.defaultApprover;

export async function notify(ctx: StepContext, kind: Notice, lines: string[], url: string) {
  const t = await ctx.tracker.ticket(ticketRef(ctx));
  await ctx.chat.notify(kind, t.title, lines, url || t.url);
}

// The dashboard's switches and requests as one step or one poll tick sees them.
export interface Controls {
  switchOn(name: SwitchName): boolean; // a running step's switch, or new_runs before a new run starts
  resumeOn(name: SwitchName): boolean; // the poller may resume a run this switch stopped
  requests: ControlRequest[]; // the poller's resume, restart and pending stop requests; readyActor's restarts
  settings?: TargetSettings; // undefined when the dashboard cannot be reached
}

// The one rule for a dashboard the factory cannot reach: a running step goes on (its switch counts as on),
// no new run starts (new_runs counts as off), the poller's resumes and requests wait for the next tick,
// and readyActor keeps the actor it was given (no requests).
async function readControls(ctx: StepContext): Promise<Controls> {
  const c = await ctx.dashboard.control(ctx.target.name, ctx.record.runId).catch(() => undefined);
  if (!c) return { switchOn: (name) => name !== "new_runs" && !OFF_UNTIL_SET.has(name), resumeOn: () => false, requests: [] };
  return { switchOn: (name) => c.switches[name], resumeOn: (name) => c.switches[name], requests: c.requests, settings: c.settings ?? { thresholds: {} } };
}

// Inside a snapshot (a step in runStep, a poll tick in poll.ts main) the dashboard is read once, at the first ask.
// Outside one each call reads it. The inbox's stop check never uses this: a stop must reach a running agent at once.
export const controls = (ctx: StepContext): Promise<Controls> => ctx.snapshot?.() ?? readControls(ctx);
export function takeSnapshot(ctx: StepContext): void {
  let read: Promise<Controls> | undefined;
  ctx.snapshot = () => (read ??= readControls(ctx));
}

// The target's thresholds from the Settings page. A dashboard the factory cannot reach gives the defaults and an error,
// so the decision step sends a change that would merge alone to a person.
export async function thresholds(ctx: StepContext): Promise<{ values: Thresholds; errors: string[] }> {
  const s = (await controls(ctx)).settings;
  if (!s) return { values: { ...DEFAULT_THRESHOLDS }, errors: ["The factory could not read the target's settings from the dashboard"] };
  return checkThresholds(s.thresholds);
}

export const switchOn = async (ctx: StepContext, name: SwitchName): Promise<boolean> => (await controls(ctx)).switchOn(name);

// The ticket's inbox from the start of this run (the newest event step), so a stop posted
// between agent runs is still seen. A resumed run starts after the old stop, so it does not see it again.
// It also asks the dashboard whether a person stopped this run there, and the tracker and code host whether a person
// closed the work item or the run's change. The stop step then ends a closed run (applyOutcome in run.ts).
// Once the run has pushed, the change's comments come too. A request round reads from its cursor; any other start reads from the event.
export const inbox = (ctx: StepContext) => {
  const f = facts(ctx);
  const change = f.change;
  return makeInbox(conversation(ctx), ticketRef(ctx), (f.roundStart ? f.openRound?.cursor : undefined) ?? f.eventAt ?? new Date().toISOString(), {
    stopCheck: async () => {
      const stop = (await ctx.dashboard.control(ctx.target.name, ctx.record.runId)).stop;
      if (stop) ctx.dashboardStop = true;
      return stop;
    },
    closedCheck: () => closedByPerson(ctx),
    change,
    onRead: (t) => void (ctx.record = { ...ctx.record, heardUntil: later(ctx.record.heardUntil, t) }),
  });
};

// Runs one agent job on the harness the router picked, and adds its cost and tokens to the record.
// An author run with tools gets the inbox: comments from trusted people reach it, and a stop line stops it.
export async function agent(ctx: StepContext, role: Role, choice: RoleChoice, job: Omit<HarnessJob, "role" | "model">): Promise<HarnessResult> {
  const box = role === "author" && job.tools === "code" ? inbox(ctx) : undefined;
  // Only the author's tool calls go to the dashboard. Jev and the reviewer show at step level.
  emit(ctx, "prompt", { role, prompt: job.prompt });
  const onToolCall = role === "author" ? (c: ToolCall) => void emit(ctx, "tool_call", c, { parent: ctx.stepEvent }) : undefined;
  const r = await ctx.harnesses[choice.harness].run({ ...job, ...(box ? { inbox: box } : {}), ...(onToolCall ? { onToolCall } : {}), role, model: modelChoice(choice, ctx.seams) });
  emit(ctx, "usage", { role, model: choice.model, input: r.tokens.input, output: r.tokens.output, cacheRead: r.tokens.cacheRead, cacheWrite: r.tokens.cacheWrite, costUsd: r.costUsd, contextTokens: r.contextTokens, ...(r.limits && { limits: r.limits }) });
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

// The commands the author may run: the gate's own, so it can check its work as the gate will, the target's extra author commands, and the screenshot and video scripts.
// Claude Code checks a chained command part by part, so each part of `a && b` is its own allow entry.
export const SHOOT = "bash run/shoot.sh";
export const RECORD = "bash run/record.sh";
export const agentCommands = (c?: FactoryCommands) =>
  c ? [c.lint, c.test, c.build, c.preview, ...(c.author ?? [])].filter((x): x is string => !!x).flatMap((x) => x.split(/&&|\|\||;/).map((p) => p.trim()).filter(Boolean)).concat(c.preview ? [SHOOT, RECORD] : []) : [];

// The clone sits in a folder named run/, so an agent took the factory's run/ for its own. The absolute path settles it.
export const rootLine = (dir: string) => `This repo's root is \`${dir}\`. Every \`run/\` path in these rules is under \`${join(dir, "run")}/\`.`;


// Resume the author session with feedback from the reviewer or the gate.
export async function fix(ctx: StepContext, feedback: string): Promise<HarnessResult> {
  const f = facts(ctx);
  const resume = f.session;
  if (!resume) throw new Error("The run record has no author session to fix");
  const preview = !!f.commands?.preview;
  writeShooter(ctx.dir, f.commands);
  const job = { tools: "code" as const, resume, prompt: `${prompt("fix")}${localSection(await ctx.repo.readBase(localPath("author")))}\n\n${rootLine(ctx.dir)}\n\n<feedback>\n${feedback}\n</feedback>`, cwd: ctx.dir, maxTurns: 30, commands: agentCommands(f.commands), ...(preview && { preview }) };
  // Each fix is its own "patch" step on the dashboard, inside the review or gate step that asked for it.
  // Its tool calls and usage go to the patch step.
  return withStep(ctx, "patch", () => agent(ctx, "author", modelRow(ctx).author, job), {
    data: { prompt: feedback },
    outcome: (r) => (r.limitHit ? "waiting" : r.stopped ? "stopped" : r.ok ? "next" : "error"),
  });
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

// Copies what the step writes to stdout and stderr, as a CI job log would hold it. Output of a child process
// that writes to the terminal itself is not in it. Calling the returned function stops the copy and gives the end of it.
function copyOutput(): () => string {
  let out = "";
  const undo = [process.stdout, process.stderr].map((s) => {
    const write = s.write;
    s.write = ((chunk: unknown, ...rest: unknown[]) => {
      out = (out + String(chunk)).slice(-MAX_FIELD);
      return (write as (...a: unknown[]) => boolean).call(s, chunk, ...rest);
    }) as typeof s.write;
    return () => (s.write = write);
  });
  return () => (undo.forEach((u) => u()), out);
}

const TRANSIENT = /status 5\d\d|fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN/;
// A step that lost its connection (git over HTTP, a fetch) waits and runs again before it blocks the ticket.
const NETWORK = /fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|RPC failed|early EOF|remote end hung up|Could not resolve host|Connection (timed out|reset|refused)|Operation timed out/i;
export const NETWORK_TRIES = 5;
export const NETWORK_WAIT_MS = 10 * 60_000;

// Runs the step again after a network error, up to NETWORK_TRIES more times, NETWORK_WAIT_MS apart. The ticket shows waiting meanwhile.
// ponytail: the job holds its slot for the whole wait; a worker that dies mid-wait leaves the ticket waiting for a person.
async function withNetworkRetry(ctx: StepContext, name: string, run: (ctx: StepContext) => Promise<StepOutcome>): Promise<StepOutcome> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run(ctx);
    } catch (e) {
      const ref = ctx.ci.vars.ticket ?? facts(ctx).ticket;
      if (attempt > NETWORK_TRIES || !ref || !NETWORK.test(errText(e))) throw e;
      const text = md("⏳", "Waiting for the network", `The \`${name}\` step lost its connection. The factory tries it again in ${NETWORK_WAIT_MS / 60_000} minutes (try ${attempt} of ${NETWORK_TRIES}).`, `\`\`\`\n${errText(e, 500)}\n\`\`\``);
      await conversation(ctx).write(ref, { kind: "networkWait", text });
      await ctx.tracker.setState(ref, "waiting");
      await ctx.sleep(NETWORK_WAIT_MS);
      await ctx.tracker.setState(ref, "running");
    }
  }
}
// What the step_end event says: the dashboard reads "stopped" and "waiting".
export const endKind = (o: StepOutcome): EndKind => (o.kind === "next" || o.kind === "stopped" || o.kind === "waiting" ? o.kind : "stop");

// Sends a label_change for every state the steps set and a jev_answer for every Jev answer, so no step has to.
// The event names the state without the tracker's factory_ label prefix; the dashboard picks the run's buttons by the last one.
const WATCHED = Symbol("watched");
function watch(ctx: StepContext): void {
  const { tracker, judge } = ctx;
  if (WATCHED in tracker) return; // a test may run every step on one context
  ctx.tracker = Object.assign(Object.create(tracker) as Tracker, {
    [WATCHED]: true,
    setState: async (ref: TicketRef, state: FactoryState) => {
      await tracker.setState(ref, state);
      emit(ctx, "label_change", { to: state });
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
// An outcome other than next is a normal end. Only unexpected errors fail the job, and they block the ticket first.
export async function runStep(
  name: string,
  run: (ctx: StepContext) => Promise<StepOutcome>,
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
  // Without a CI job there is no job log to read, so the step's output goes with its step_end event.
  const output = ctx.ci.vars.job ? undefined : copyOutput();
  const log = () => (output ? { log: output() } : {});
  ctx.job = ctx.step = name;
  ctx.stepEvent = undefined;
  takeSnapshot(ctx);
  // Do not leave the ticket stuck in a running state. A block needs a ticket; without one it throws and we go on.
  const fail = async (e: unknown) => {
    emit(ctx, "error", { message: errText(e, 500) });
    await applyOutcome(ctx, block(`The \`${name}\` step failed:\n\n\`\`\`\n${errText(e, 500)}\n\`\`\``, { continuable: false })).catch(() => {});
  };
  let result: StepOutcome;
  try {
    try {
      ctx.record = await loadRunRecord(ctx, dir).catch((e) => {
        // A round on a change whose build run was never saved: requestRound sees the empty record, leaves a note and starts nothing.
        if (name === "event" && ctx.ci.vars.change && e instanceof NotFactoryRunError) return newRecord();
        throw e;
      });
    } catch (e) {
      // A resume whose record cannot be read now (a server 5xx or a network error) waits for the next hourly retry.
      // Anything else (forged, 404, no decision job, a bad record) will not get better: block, so a person hears.
      if (name !== "event" || !ctx.ci.vars.buildRun || !TRANSIENT.test(String(e))) {
        await fail(e);
        throw e;
      }
      save(ctx, "event", { start: false, reason: "record-unavailable", error: errText(e, 500) });
      mkdirSync(dir, { recursive: true });
      writeFileSync(stopFile, name);
      return;
    }
    if (doneBeforeResume(ctx, name)) {
      console.log(`Skipping ${name}: it finished before the run was resumed.`);
      return;
    }
    result = await withStep(ctx, name, async () => applyOutcome(ctx, await withNetworkRetry(ctx, name, run)), { outcome: endKind, endData: log, onError: fail, deferStart: name === "event" });
  } finally {
    output?.(); // stops the copy when the step ended before step_end, as in a skip
    saveRecord(ctx.record, dir); // also creates the dir
    await ctx.dashboard.flush();
    ctx.snapshot = undefined; // the next step reads the dashboard again
  }
  if (result.kind !== "next") writeFileSync(stopFile, name);
}

// Runs main() only when the file is the script node started, not when a test imports it.
export function isMain(url: string): boolean {
  return process.argv[1] !== undefined && url === pathToFileURL(process.argv[1]).href;
}
