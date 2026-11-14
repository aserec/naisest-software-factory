import { expect, test } from "vitest";
import { fakeTracker } from "../fakes";
import { fakeDashboard } from "../fakes";
import { finishCancelledStops } from "./poller";
import type { StepContext } from "./context";
import { fakeCtx, fakeWorld } from "./test-helpers";
import { ENDED, NEXT, facts } from "./context";
import { applyOutcome, block, stopped, waiting } from "./run";

// The poller finishes a stop the dashboard cancelled. One bad request must not hold up the others.
const cancelled = (ticket: string) => ({ id: `q${ticket}`, kind: "stop" as const, run: "run-1", target: "react_frontend", ticket, user: "dev", at: "2026-10-29T00:00:00Z", outcome: "cancelled" as const });
test("a cancelled stop for a deleted ticket is marked done and does not block the next request", async () => {
  const ctx = fakeCtx({ running: 1 });
  const dash = fakeDashboard({ requests: [cancelled("gone"), cancelled("r0")] });
  ctx.dashboard = dash;
  expect(await finishCancelledStops(ctx)).toEqual(["r0"]);
  expect(dash.done).toEqual([["qgone", "done"], ["qr0", "done"]]);
});
test("a cancelled stop that fails is left for the next poll and the others still run", async () => {
  const ctx = fakeCtx({ running: 2 });
  const dash = fakeDashboard({ requests: [cancelled("r0"), cancelled("r1")] });
  ctx.dashboard = dash;
  const comment = ctx.tracker.comment.bind(ctx.tracker);
  ctx.tracker.comment = async (ref, text) => { if (ref === "r0") throw new Error("status 500"); return comment(ref, text); };
  expect(await finishCancelledStops(ctx)).toEqual(["r1"]);
  expect(dash.done).toEqual([["qr1", "done"]]);
});

// GLOSSARY.md: Step outcome. applyOutcome makes the writes for each kind; a step only returns the outcome.
test.each([
  { o: NEXT, state: "running" },
  { o: ENDED, state: "running" },
  { o: block("tests fail"), state: "blocked" },
  { o: waiting("prepare-patch", "s1"), state: "waiting" },
  { o: stopped("prepare-patch", { session: "s1", reason: "stopped by @factory stop" }), state: "stopped" },
])("applyOutcome $o.kind sets the work item $state", async ({ o, state }) => {
  const w = fakeWorld({ state: "running" });
  w.ctx.ci.vars.ticket = "8";
  expect(await applyOutcome(w.ctx, o)).toBe(o);
  expect(w.states).toEqual([state]);
  expect(w.assigned).toBe(o.kind === "blocked"); // only a block hands the work item to a person
  expect(facts(w.ctx).paused).toEqual(o.kind === "waiting" ? expect.objectContaining({ limit: true, sessionId: "s1" }) : o.kind === "stopped" ? expect.objectContaining({ stopped: true, sessionId: "s1" }) : undefined);
});
test("applyOutcome ends a stop on a work item a person closed as a closed run", async () => {
  const w = fakeWorld({ state: "running" });
  w.ctx.ci.vars.ticket = "8";
  await w.tracker.close("8");
  expect((await applyOutcome(w.ctx, stopped("prepare-patch", { reason: "stopped by @factory stop" }))).kind).toBe("closed");
  expect(w.states).toEqual([]);
});
