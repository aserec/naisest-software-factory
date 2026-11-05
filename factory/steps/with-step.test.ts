import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { emit } from "../emit";
import type { fakeDashboard } from "../fakes";
import { fakeWorld } from "./test-helpers";
import { startStep, withStep } from "./with-step";

// A context whose run has an ID, and the events it sent.
const world = (runId?: string) => {
  const w = fakeWorld();
  w.ctx.dir = join(mkdtempSync(join(tmpdir(), "with-step-")), "target");
  w.ctx.record = { ...w.ctx.record, runId };
  const events = () => (w.ctx.dashboard as ReturnType<typeof fakeDashboard>).events;
  return { ctx: w.ctx, events };
};
const next = () => "next" as const;

test("a step sends its start, runs, then sends its end with the outcome, the end under the start", async () => {
  const { ctx, events } = world("run-1");
  const result = await withStep(ctx, "triage", async () => {
    expect(events().map((e) => [e.type, e.step])).toEqual([["step_start", "triage"]]);
    return "stop" as const;
  }, { outcome: () => "stopped" });
  expect(result).toBe("stop");
  const [start, end] = events();
  expect([start.type, start.step, start.parent, start.data]).toEqual(["step_start", "triage", undefined, {}]);
  expect([end.type, end.step, end.parent, end.data]).toEqual(["step_end", "triage", start.id, { outcome: "stopped" }]);
});

test("the start carries the data it was given and the end the extra data", async () => {
  const { ctx, events } = world("run-1");
  await withStep(ctx, "patch", async () => 1, { outcome: next, data: { prompt: "fix it" }, endData: () => ({ log: "output" }) });
  expect(events().map((e) => e.data)).toEqual([{ prompt: "fix it" }, { outcome: "next", log: "output" }]);
});

test("what the step sends is under its start, and a nested step is its own step: its events go under it and the outer step's IDs come back", async () => {
  const { ctx, events } = world("run-1");
  let outerStart = "";
  await withStep(ctx, "code-review", async () => {
    outerStart = ctx.stepEvent!;
    await withStep(ctx, "patch", async () => {
      expect(ctx.step).toBe("patch");
      emit(ctx, "usage", {});
    }, { outcome: next });
    expect([ctx.step, ctx.stepEvent]).toEqual(["code-review", outerStart]);
    emit(ctx, "review_finding", {});
  }, { outcome: next });
  expect([ctx.step, ctx.stepEvent]).toEqual([undefined, undefined]);
  const byType = (t: string, step: string) => events().find((e) => e.type === t && e.step === step)!;
  const patchStart = byType("step_start", "patch");
  expect(byType("step_start", "code-review").id).toBe(outerStart);
  expect(patchStart.parent).toBeUndefined();
  expect(byType("usage", "patch").parent).toBe(patchStart.id);
  expect(byType("step_end", "patch").parent).toBe(patchStart.id);
  expect(byType("review_finding", "code-review").parent).toBe(outerStart);
  expect(byType("step_end", "code-review").parent).toBe(outerStart);
  expect(events().map((e) => [e.type, e.step])).toEqual([
    ["step_start", "code-review"], ["step_start", "patch"], ["usage", "patch"], ["step_end", "patch"], ["review_finding", "code-review"], ["step_end", "code-review"],
  ]);
});

test("a throw sends the end as error after onError ran, restores the context and passes the throw on", async () => {
  const { ctx, events } = world("run-1");
  ctx.step = "outer";
  ctx.stepEvent = "outer-start";
  const seen: string[] = [];
  await expect(withStep(ctx, "triage", async () => { throw new Error("boom"); }, {
    outcome: next,
    endData: () => ({ log: "tail" }),
    onError: async (e) => {
      seen.push(`${String(e)} while ${ctx.step}`);
      emit(ctx, "error", { message: "boom" }); // as runStep sends it, under the step
    },
  })).rejects.toThrow("boom");
  expect(seen).toEqual(["Error: boom while triage"]);
  expect(events().map((e) => [e.type, e.parent === events()[0].id])).toEqual([["step_start", false], ["error", true], ["step_end", true]]);
  expect(events().at(-1)?.data).toEqual({ outcome: "error", log: "tail" });
  expect([ctx.step, ctx.stepEvent]).toEqual(["outer", "outer-start"]);
});

test("a deferred start sends nothing until startStep, and the end only after a start", async () => {
  const quiet = world("run-1");
  await withStep(quiet.ctx, "event", async () => "stop" as const, { outcome: () => "stop", deferStart: true });
  expect(quiet.events()).toEqual([]);

  const { ctx, events } = world("run-1");
  await withStep(ctx, "event", async () => {
    expect([ctx.step, ctx.stepEvent]).toEqual(["event", undefined]);
    startStep(ctx, { round: 2 });
    emit(ctx, "label_change", { to: "factory_running" });
    return "next" as const;
  }, { outcome: next, deferStart: true });
  const [start, change, end] = events();
  expect([start.type, start.step, start.data]).toEqual(["step_start", "event", { round: 2 }]);
  expect([change.parent, end.type, end.parent, end.data]).toEqual([start.id, "step_end", start.id, { outcome: "next" }]);
});

test("a step whose run has no ID yet sends nothing, and still runs and restores the context", async () => {
  const { ctx, events } = world();
  expect(await withStep(ctx, "triage", async () => 7, { outcome: next })).toBe(7);
  expect(events()).toEqual([]);
  expect([ctx.step, ctx.stepEvent]).toEqual([undefined, undefined]);
});
