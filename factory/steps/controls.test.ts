import { expect, test } from "vitest";
import { controls } from "./context";
import { fakeWorld } from "./test-helpers";
import { fakeDashboard } from "../fakes";

test("with the dashboard down a step's switch is on, new_runs is off, and the poller has nothing to resume or handle", async () => {
  const w = fakeWorld();
  const dash = fakeDashboard({ requests: [{ id: "q1", kind: "resume", run: "r", target: "t", ticket: "7", user: "dev", at: "2026-10-29T00:00:00Z" }] });
  dash.down = true;
  w.ctx.dashboard = dash;
  const c = await controls(w.ctx);
  expect([c.switchOn("prepare_patch"), c.switchOn("new_runs"), c.resumeOn("prepare_patch"), c.requests]).toEqual([true, false, false, []]);
});
