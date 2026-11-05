import { expect, test } from "vitest";
import { fakeTracker } from "../fakes";
import { fakeDashboard } from "../fakes";
import { finishCancelledStops } from "./run";
import type { StepContext } from "./context";
import { fakeCtx } from "./test-helpers";

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
