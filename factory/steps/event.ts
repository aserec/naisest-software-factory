import type { FactoryEvent } from "../seams";
import { buildRunOf } from "./merge";
import { answerRequests, requestRound } from "./requests";
import { isMain, runStep, save, switchOn, type StepContext, type StepResult } from "./context";
// The start rules sit in run.ts: run.ts cannot import this file, whose isMain line runs at load.
import { activeRuns, continueBlocked, decideStart, mayStart, readyActor, resume, resumeOnCommand, startRun } from "./run";

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
  const buildRun = buildRunOf((await ctx.codeHost.change(e.change)).body);
  ctx.record = { ...ctx.record, workItem: `${ctx.target.projectPath}#${e.ticket}` };
  save(ctx, "event", { start: true, ticket: e.ticket, actor: e.actor, action: e.kind, change: e.change });
  await ctx.tracker.setState(e.ticket, "running");
  await ctx.ci.start({ kind: "finish", ticket: e.ticket, change: e.change, ...(buildRun ? { buildRun } : {}), skipApply: true });
  return "stop";
}

// A person's `@factory stop` or `@factory resume`. A stop only matters inside a run, where the agent's inbox or the decision step sees it.
async function commandEvent(ctx: StepContext, e: Extract<FactoryEvent, { kind: "command" }>): Promise<StepResult> {
  const quiet = (reason: string) => (save(ctx, "event", { start: false, reason, ticket: e.ticket, command: e.command }), "stop" as const);
  const state = (await ctx.tracker.ticket(e.ticket)).state;
  if (e.command === "stop") return quiet(state === "running" ? "in-run" : "not-running");
  if (await ctx.tracker.isFactory(e.actor)) return quiet("bot");
  if (!(await ctx.tracker.trusted(e.actor))) return quiet("not-member");
  if (state !== "stopped") return quiet("not-stopped");
  return resumeOnCommand(ctx, e.ticket, e.actor, quiet);
}

// A person's `@factory` request: the poller's answer, given at once. The round itself starts in the build that answerRequests starts.
async function requestEvent(ctx: StepContext, e: Extract<FactoryEvent, { kind: "request" }>): Promise<StepResult> {
  const quiet = (reason: string) => (save(ctx, "event", { start: false, reason, ticket: e.ticket }), "stop" as const);
  if (await ctx.tracker.isFactory(e.actor)) return quiet("bot");
  if (!(await ctx.tracker.trusted(e.actor))) return quiet("not-member");
  // Only the ticket's open change counts.
  if (e.change !== undefined && (await ctx.codeHost.changeOfTicket(e.ticket).then((c) => (c?.open ? c.ref : undefined))) !== e.change) return quiet("other-change");
  return quiet(await answerRequests(ctx, await ctx.tracker.ticket(e.ticket)));
}

export async function run(ctx: StepContext): Promise<StepResult> {
  const { payload, ticket, buildRun, change } = ctx.ci.vars;
  // With a change: the poller's round build for a request (requestRound stops quietly unless the change still waits). Without: a paused run to continue.
  if (payload === undefined && ticket && buildRun) return change ? requestRound(ctx, ticket, buildRun, change) : resume(ctx, ticket, buildRun);
  // The poller starts with no payload. Build the event from who set the ticket ready,
  // so decideStart checks exactly what it checks for a webhook.
  let e: FactoryEvent = payload === undefined && ticket ? { kind: "ready", ticket, actor: (await ctx.tracker.startedBy(ticket)) ?? "" } : ctx.tracker.parseEvent(payload);
  if (e.kind === "merged") return changeEvent(ctx, e);
  if (e.kind === "command") return commandEvent(ctx, e);
  if (e.kind === "request") return requestEvent(ctx, e);
  if (e.kind !== "ready") {
    save(ctx, "event", { start: false, reason: e.kind === "ignored" ? e.reason : "not-added" });
    return "stop";
  }
  // The ticket stays ready, so the poller starts it once new_runs is on again.
  if (!(await switchOn(ctx, "new_runs"))) {
    save(ctx, "event", { start: false, reason: "switch-off" });
    return "stop";
  }
  const ready = await readyActor(ctx, e.ticket, e.actor);
  e = { ...e, actor: ready.actor };
  const t = await ctx.tracker.ticket(e.ticket);
  const decision = decideStart(e, {
    actorTrusted: await mayStart(ctx, e.actor, t),
    state: t.state,
    runningInRepo: await activeRuns(ctx),
  });
  // A dashboard restart asks for a new run, so it never continues an older blocked run.
  if (decision.start && t.ended === "blocked" && !ready.restart) {
    const r = await continueBlocked(ctx, e);
    if (r) return r;
  }
  ctx.record = { ...ctx.record, workItem: `${ctx.target.projectPath}#${e.ticket}` };
  save(ctx, "event", { ticket: e.ticket, actor: e.actor, ...decision });
  if (!decision.start) return "stop";
  // A new run: the marks of the earlier run no longer say anything.
  for (const m of t.marks) if (m !== "watcher") await ctx.tracker.unmark(e.ticket, m);
  return startRun(ctx, e.ticket);
}

export const main = () => runStep("event", run);
if (isMain(import.meta.url)) await main();
