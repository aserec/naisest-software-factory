import { expect, test } from "vitest";
import type { RunEvent } from "software-factory/run-events";
import type { RunSummary } from "./db";
import { insights, pct, weekStart } from "./insights";

const now = new Date("2026-11-05T12:00:00Z"); // a Thursday
const run = (id: string, startedAt: string, more: Partial<RunSummary> = {}): RunSummary => ({ run: id, target: "web", ticket: id, startedAt, costUsd: 1, ...more });
let n = 0;
const ev = (run: string, at: string, type: "step_start" | "step_end" | "decision", step: string, data: object = {}) =>
  ({ id: `e${n++}`, run, at, target: "web", ticket: run, step, type, data }) as unknown as RunEvent;

test("percentiles take the nearest rank, and weeks start on Monday", () => {
  expect([pct([], 50), pct([4, 1, 3, 2], 50), pct([1, 2, 3, 4, 100], 95)]).toEqual([0, 2, 100]);
  expect(new Date(weekStart(now.getTime())).toISOString()).toBe("2026-11-02T00:00:00.000Z");
});

test("a run counts in its week by what the decision said, and old runs fall out", () => {
  const runs = [
    run("a", "2026-11-03T10:00:00Z", { endedAt: "2026-11-03T10:30:00Z", outcome: "done", costUsd: 2 }),
    run("b", "2026-11-04T10:00:00Z", { costUsd: 4 }),
    run("c", "2026-10-28T10:00:00Z", { endedAt: "2026-10-28T11:00:00Z", outcome: "blocked", lastStep: { step: "code-review", startedAt: "", ended: true } }),
    run("old", "2026-01-01T10:00:00Z"),
  ];
  const events = [ev("a", "2026-11-03T10:20:00Z", "decision", "decision", { auto: true, reasons: [] }), ev("b", "2026-11-04T10:20:00Z", "decision", "decision", { auto: false, reasons: [] })];
  const i = insights(runs, events, now, { weeks: 2, budgets: { web: 10 } });
  expect(i.weeks).toEqual([
    { start: "2026-10-26T00:00:00.000Z", auto: 0, person: 0, stopped: 1 },
    { start: "2026-11-02T00:00:00.000Z", auto: 1, person: 1, stopped: 0 },
  ]);
  expect(i.runs).toBe(3);
  expect(i.time).toEqual({ p50: 1800, p95: 3600 }); // the open run b has no time yet
  expect(i.steps.find((s) => s.step === "code-review")?.blocked).toBe(1);
  expect(i.targets).toEqual([{ target: "web", runs: 3, cost: 7, p50: 2, p95: 4, week: 6, budget: 10 }]);
});

test("a step's time runs from its start to its end, and a step that ran twice counts twice", () => {
  const runs = [run("a", "2026-11-03T10:00:00Z")];
  const events = [
    ev("a", "2026-11-03T10:00:00Z", "step_start", "code-review"),
    ev("a", "2026-11-03T10:01:00Z", "step_end", "code-review", { outcome: "next" }),
    ev("a", "2026-11-03T10:02:00Z", "step_start", "code-review"),
    ev("a", "2026-11-03T10:05:00Z", "step_end", "code-review", { outcome: "next" }),
    ev("a", "2026-11-03T10:06:00Z", "step_start", "verify"), // still running: reached, no time
  ];
  const steps = insights(runs, events, now).steps;
  expect(steps.find((s) => s.step === "code-review")).toMatchObject({ reached: 1, p50: 60, p95: 180 });
  expect(steps.find((s) => s.step === "verify")).toMatchObject({ reached: 1, p50: 0 });
});
