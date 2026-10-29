import { ACTIVE_STATES, MAX_RUNS_PER_REPO, decideStart } from "../event";
import type { FactoryEvent, TicketRef } from "../seams";
import { block, data, isMain, runStep, save, STOPPED_RUN, type StepContext, type StepResult } from "./context";

// Caller side of decideStart's contract: CI runs this job in a resource_group, the state is read live,
// and the running state is set before the job ends.

// Spec 6.7: a person approved a factory change, or merged it by hand. Start the finish run
// (with apply skipped after a manual merge). The build run itself stops here.
async function changeEvent(ctx: StepContext, e: Extract<FactoryEvent, { kind: "approved" | "merged" }>): Promise<StepResult> {
  const quiet = (reason: string) => (save(ctx, "event", { start: false, reason, change: e.change }), "stop" as const);
  // The factory's own merge in apply sends a merge event too.
  if (await ctx.tracker.isFactory(e.actor)) return quiet("bot");
  if (!(await ctx.tracker.trusted(e.actor))) return quiet("not-member");
  // Only a change that waits for a person. This also ignores approvals while the build is still running.
  if ((await ctx.tracker.ticket(e.ticket)).state !== "needs_approval") return quiet("not-waiting");
  // No end anchor: a body edited in the web UI may end its lines in \r\n.
  const buildRun = /^Factory run (\d+): /m.exec((await ctx.codeHost.change(e.change)).body)?.[1];
  ctx.record = { ...ctx.record, workItem: `${ctx.target.projectPath}#${e.ticket}` };
  save(ctx, "event", { start: true, ticket: e.ticket, actor: e.actor, action: e.kind, change: e.change });
  await ctx.tracker.setState(e.ticket, "running");
  await ctx.ci.start({ kind: "finish", ticket: e.ticket, change: e.change, ...(buildRun ? { buildRun } : {}), ...(e.kind === "merged" ? { skipApply: true } : {}) });
  return "stop";
}

// Tickets in the repo that hold a run slot.
export async function activeRuns(ctx: StepContext): Promise<number> {
  const lists = await Promise.all(ACTIVE_STATES.map((s) => ctx.tracker.list(s)));
  return lists.reduce((n, l) => n + l.length, 0);
}

// The hourly retry asks to resume a run that stopped at the agent's usage limit, and a `@factory resume` comment
// asks to resume a stopped run. The record is loaded already, through the provenance-checked loader. Never start over silently.
async function resume(ctx: StepContext, ref: TicketRef, buildRun: string): Promise<StepResult> {
  const quiet = (reason: string) => (save(ctx, "event", { start: false, reason, ticket: ref }), "stop" as const);
  const state = (await ctx.tracker.ticket(ref)).state;
  if (state !== "waiting" && state !== "stopped") return quiet("not-waiting");
  const last = ctx.record.steps.at(-1);
  const d = last?.data as { sessionId?: string; limit?: boolean; stopped?: boolean } | undefined;
  if (ctx.record.workItem !== `${ctx.target.projectPath}#${ref}`) return block(ctx, `The factory could not resume this run: the record of pipeline ${buildRun} is for another ticket. Add factory_ready to start again.`);
  if (!(d?.limit || d?.stopped) || !d.sessionId) return block(ctx, `The factory could not resume this run: the record of pipeline ${buildRun} has no saved session. Add factory_ready to start again.`);
  // A record from before the router named a harness per role cannot be continued.
  if (typeof data(ctx, "triage")?.row?.author !== "object") return block(ctx, `The factory could not resume this run: the record of pipeline ${buildRun} is from an older factory version. Add factory_ready to start again.`);
  // This ticket is waiting, so it is one of the active runs already.
  if ((await activeRuns(ctx)) - 1 >= MAX_RUNS_PER_REPO) return quiet("repo-full");
  await ctx.ci.restoreRun(buildRun);
  // The questions agent runs inside the triage job.
  const resumeAt = last!.step === "questions" ? "triage" : last!.step;
  save(ctx, "event", { start: true, resume: true, ticket: ref, fromPipeline: buildRun, resumeAt, sessionId: d.sessionId });
  await ctx.tracker.setState(ref, "running");
  return "next";
}

// A person's `@factory stop` or `@factory resume`. A stop only matters inside a run, where the agent's inbox sees it.
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
  if (e.kind === "approved" || e.kind === "merged") return changeEvent(ctx, e);
  if (e.kind === "command") return commandEvent(ctx, e);
  if (e.kind !== "ready") {
    save(ctx, "event", { start: false, reason: e.kind === "ignored" ? e.reason : "not-added" });
    return "stop";
  }
  const decision = decideStart(e, {
    actorTrusted: e.actor !== "" && (await ctx.tracker.trusted(e.actor)),
    state: (await ctx.tracker.ticket(e.ticket)).state,
    runningInRepo: await activeRuns(ctx),
  });
  ctx.record = { ...ctx.record, workItem: `${ctx.target.projectPath}#${e.ticket}` };
  save(ctx, "event", { ticket: e.ticket, actor: e.actor, ...decision });
  if (!decision.start) return "stop";
  await ctx.tracker.setState(e.ticket, "running");
  return "next";
}

export const main = () => runStep("event", run);
if (isMain(import.meta.url)) await main();
