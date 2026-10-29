import type { FactoryEvent, FactoryState } from "./seams";

export const MAX_RUNS_PER_REPO = 2;
// A ticket in one of these states already has a run. needs_info, blocked and done do not.
export const ACTIVE_STATES: FactoryState[] = ["running", "waiting", "stopped", "needs_approval"];

export type StartDecision = { start: true } | { start: false; reason: "not-added" | "not-ready" | "not-member" | "active-run" | "repo-full" };

// Caller contract:
// (a) handle one ticket at a time (the event job runs in a CI resource_group per target, which also guards the run count);
// (b) pass the state read live from the tracker, not from the event;
// (c) set the running state before handling the next event;
// (d) runningInRepo is the number of OTHER active runs in the repo, not counting this ticket.
export function decideStart(e: FactoryEvent, ctx: { actorTrusted: boolean; state?: FactoryState; runningInRepo: number }): StartDecision {
  if (e.kind !== "ready") return { start: false, reason: "not-added" };
  const active = ctx.state !== undefined && ACTIVE_STATES.includes(ctx.state);
  // The event may be old: someone may have taken the ready state off since.
  if (ctx.state !== "ready" && !active) return { start: false, reason: "not-ready" };
  if (!ctx.actorTrusted) return { start: false, reason: "not-member" };
  if (active) return { start: false, reason: "active-run" };
  if (ctx.runningInRepo >= MAX_RUNS_PER_REPO) return { start: false, reason: "repo-full" };
  return { start: true };
}
