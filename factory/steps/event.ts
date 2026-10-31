import { ACTIVE_STATES, MAX_RUNS_PER_REPO, decideStart } from "../event";
import type { FactoryEvent, Ticket, TicketRef } from "../seams";
import { block, BLOCKED, BLOCKED_RUN, CONTINUABLE, data, isMain, runStep, save, STOPPED_RUN, type StepContext, type StepResult } from "./context";

// Caller side of decideStart's contract: CI runs this job in a resource_group, the state is read live,
// and the running state is set before the job ends.

// Spec 6.5: a person merged a factory change by hand. Start the finish run with apply skipped.
// An approval starts nothing. The build run itself stops here.
async function changeEvent(ctx: StepContext, e: Extract<FactoryEvent, { kind: "merged" }>): Promise<StepResult> {
  const quiet = (reason: string) => (save(ctx, "event", { start: false, reason, change: e.change }), "stop" as const);
  // The factory's own merge in apply sends a merge event too.
  if (await ctx.tracker.isFactory(e.actor)) return quiet("bot");
  if (!(await ctx.tracker.trusted(e.actor))) return quiet("not-member");
  // Only a change that waits for a person. This also ignores merges while the build is still running.
  if ((await ctx.tracker.ticket(e.ticket)).state !== "needs_approval") return quiet("not-waiting");
  // No end anchor: a body edited in the web UI may end its lines in \r\n.
  const buildRun = /^Factory run (\d+): /m.exec((await ctx.codeHost.change(e.change)).body)?.[1];
  ctx.record = { ...ctx.record, workItem: `${ctx.target.projectPath}#${e.ticket}` };
  save(ctx, "event", { start: true, ticket: e.ticket, actor: e.actor, action: e.kind, change: e.change });
  await ctx.tracker.setState(e.ticket, "running");
  await ctx.ci.start({ kind: "finish", ticket: e.ticket, change: e.change, ...(buildRun ? { buildRun } : {}), skipApply: true });
  return "stop";
}

// Tickets in the repo that hold a run slot.
export async function activeRuns(ctx: StepContext): Promise<number> {
  const lists = await Promise.all(ACTIVE_STATES.map((s) => ctx.tracker.list(s)));
  return lists.reduce((n, l) => n + l.length, 0);
}

// May this person's ready start a run? A trusted person may. The factory may only for the watcher's own
// tickets, which it opens ready. trusted() stays false for the factory, so it still cannot command.
export async function mayStart(ctx: StepContext, actor: string, ticket: Ticket): Promise<boolean> {
  if (actor === "") return false;
  if (await ctx.tracker.trusted(actor)) return true;
  return ticket.marks.includes("watcher") && (await ctx.tracker.isFactory(actor));
}

// Why the record of buildRun cannot be continued for this ticket, or undefined if it can.
function unusable(ctx: StepContext, ref: TicketRef, buildRun: string): string | undefined {
  if (ctx.record.workItem !== `${ctx.target.projectPath}#${ref}`) return `the record of pipeline ${buildRun} is for another ticket`;
  // A record from before the router named a harness per role cannot be continued.
  if (typeof data(ctx, "triage")?.row?.author !== "object") return `the record of pipeline ${buildRun} is from an older factory version`;
  return undefined;
}

// Continue the loaded run: the build jobs before resumeAt skip.
async function continueAt(ctx: StepContext, ref: TicketRef, resumeAt: string, d: object): Promise<StepResult> {
  save(ctx, "event", { start: true, resume: true, ticket: ref, resumeAt, ...d });
  await ctx.tracker.setState(ref, "running");
  return "next";
}

// The hourly retry asks to resume a run that stopped at the agent's usage limit, and a `@factory resume` comment
// asks to resume a stopped run. The record is loaded already, through the provenance-checked loader. Never start over silently.
async function resume(ctx: StepContext, ref: TicketRef, buildRun: string): Promise<StepResult> {
  const quiet = (reason: string) => (save(ctx, "event", { start: false, reason, ticket: ref }), "stop" as const);
  const state = (await ctx.tracker.ticket(ref)).state;
  if (state !== "waiting" && state !== "stopped") return quiet("not-waiting");
  const last = ctx.record.steps.at(-1);
  const d = last?.data as { sessionId?: string; limit?: boolean; stopped?: boolean } | undefined;
  const why = unusable(ctx, ref, buildRun) ?? (!(d?.limit || d?.stopped) || !d.sessionId ? `the record of pipeline ${buildRun} has no saved session` : undefined);
  if (why) return block(ctx, `The factory could not resume this run: ${why}. Add factory_ready to start again.`);
  // This ticket is waiting, so it is one of the active runs already.
  if ((await activeRuns(ctx)) - 1 >= MAX_RUNS_PER_REPO) return quiet("repo-full");
  await ctx.ci.restoreRun(buildRun);
  // The questions agent runs inside the triage job.
  return continueAt(ctx, ref, last!.step === "questions" ? "triage" : last!.step, { fromPipeline: buildRun, sessionId: d!.sessionId });
}

// A person set a blocked ticket ready again: continue the run at the job that blocked. Undefined: start a new run.
// Only the factory's newest block comment counts, so an older run line never wins over a newer block without one.
async function continueBlocked(ctx: StepContext, e: Extract<FactoryEvent, { kind: "ready" }>): Promise<StepResult | undefined> {
  const note = (await ctx.tracker.comments(e.ticket)).find((c) => c.byFactory && c.body.includes(BLOCKED));
  const buildRun = note && BLOCKED_RUN.exec(note.body)?.[1];
  if (!buildRun) return undefined;
  const fresh = ctx.record;
  let at: string | undefined;
  let why: string | undefined;
  try {
    ctx.record = await ctx.ci.buildRecord(buildRun);
    const last = ctx.record.steps.at(-1);
    at = last?.step === "blocked" ? (last.data as { step?: string }).step : undefined;
    why = unusable(ctx, e.ticket, buildRun) ?? (at && CONTINUABLE.includes(at) ? undefined : `the record of pipeline ${buildRun} does not show which step blocked`);
  } catch (err) {
    why = `the record of pipeline ${buildRun} could not be loaded (${String(err).slice(0, 300)})`;
  }
  if (why) {
    ctx.record = fresh;
    await ctx.tracker.comment(e.ticket, `The factory starts a new run, because it cannot continue the blocked run: ${why}.`);
    return undefined;
  }
  // The blocked job starts its rounds again. The gate job runs code review too.
  if (at === "code-review" || at === "precommit-gate") ctx.record = { ...ctx.record, rounds: { review: 0, gate: 0 } };
  // prepare-patch starts on a fresh clone, so a half-done edit never picks the .factory.yml commands.
  if (at !== "prepare-patch") await ctx.ci.restoreRun(buildRun);
  return continueAt(ctx, e.ticket, at!, { actor: e.actor, fromPipeline: buildRun });
}

// A person's `@factory stop` or `@factory resume`. A stop only matters inside a run, where the agent's inbox or the decision step sees it.
// A resume continues the run named in the factory's own `Stopped run` comment.
async function commandEvent(ctx: StepContext, e: Extract<FactoryEvent, { kind: "command" }>): Promise<StepResult> {
  const quiet = (reason: string) => (save(ctx, "event", { start: false, reason, ticket: e.ticket, command: e.command }), "stop" as const);
  const state = (await ctx.tracker.ticket(e.ticket)).state;
  if (e.command === "stop") return quiet(state === "running" ? "in-run" : "not-running");
  if (await ctx.tracker.isFactory(e.actor)) return quiet("bot");
  if (!(await ctx.tracker.trusted(e.actor))) return quiet("not-member");
  if (state !== "stopped") return quiet("not-stopped");
  // Only the factory's own comment counts: anyone who can comment could write the same line.
  const buildRun = (await ctx.tracker.comments(e.ticket)).filter((c) => c.byFactory).map((c) => STOPPED_RUN.exec(c.body)?.[1]).find(Boolean);
  if (!buildRun) {
    quiet("no-stopped-run");
    return block(ctx, "The factory could not resume this run: it found no stopped-run comment from the factory. Add factory_ready to start again.");
  }
  try {
    ctx.record = await ctx.ci.buildRecord(buildRun);
  } catch (err) {
    quiet("record-unavailable");
    return block(ctx, `The factory could not resume this run: the record of pipeline ${buildRun} could not be loaded (${String(err).slice(0, 300)}). Add factory_ready to start again.`);
  }
  return resume(ctx, e.ticket, buildRun);
}

export async function run(ctx: StepContext): Promise<StepResult> {
  const { payload, ticket, buildRun } = ctx.ci.vars;
  if (payload === undefined && ticket && buildRun) return resume(ctx, ticket, buildRun);
  // The poller starts with no payload. Build the event from who set the ticket ready,
  // so decideStart checks exactly what it checks for a webhook.
  const e: FactoryEvent = payload === undefined && ticket ? { kind: "ready", ticket, actor: (await ctx.tracker.startedBy(ticket)) ?? "" } : ctx.tracker.parseEvent(payload);
  if (e.kind === "merged") return changeEvent(ctx, e);
  if (e.kind === "command") return commandEvent(ctx, e);
  if (e.kind !== "ready") {
    save(ctx, "event", { start: false, reason: e.kind === "ignored" ? e.reason : "not-added" });
    return "stop";
  }
  const t = await ctx.tracker.ticket(e.ticket);
  const decision = decideStart(e, {
    actorTrusted: await mayStart(ctx, e.actor, t),
    state: t.state,
    runningInRepo: await activeRuns(ctx),
  });
  if (decision.start && t.ended === "blocked") {
    const r = await continueBlocked(ctx, e);
    if (r) return r;
  }
  ctx.record = { ...ctx.record, workItem: `${ctx.target.projectPath}#${e.ticket}` };
  save(ctx, "event", { ticket: e.ticket, actor: e.actor, ...decision });
  if (!decision.start) return "stop";
  // A new run: the marks of the earlier run no longer say anything.
  for (const m of t.marks) if (m !== "watcher") await ctx.tracker.unmark(e.ticket, m);
  await ctx.tracker.setState(e.ticket, "running");
  return "next";
}

export const main = () => runStep("event", run);
if (isMain(import.meta.url)) await main();
