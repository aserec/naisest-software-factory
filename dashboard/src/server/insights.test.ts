import { expect, test } from "vitest";
import type { RunEvent } from "software-factory/run-events";
import type { RunSummary } from "./db";
import { bucketStart, insights, pct, resolveRange, unitOf } from "./insights";

const now = new Date("2026-11-05T12:00:00Z"); // a Thursday, 13:00 in Madrid
const iso = (t: number) => new Date(t).toISOString();
const run = (id: string, startedAt: string, more: Partial<RunSummary> = {}): RunSummary => ({ run: id, target: "web", ticket: id, startedAt, costUsd: 1, ...more });
let n = 0;
const ev = (run: string, at: string, type: "step_start" | "step_end" | "decision", step: string, data: object = {}) =>
  ({ id: `e${n++}`, run, at, target: "web", ticket: run, step, type, data }) as unknown as RunEvent;

test("percentiles take the nearest rank", () => {
  expect([pct([], 50), pct([4, 1, 3, 2], 50), pct([1, 2, 3, 4, 100], 95)]).toEqual([0, 2, 100]);
});

test("each range runs from and to the right instants in the viewer's time zone", () => {
  const r = (q: object, tz = "Europe/Madrid") => {
    const x = resolveRange(q, now, tz);
    return [x.key, iso(x.from), iso(x.to)];
  };
  expect(r({ range: "today" })).toEqual(["today", "2026-11-04T23:00:00.000Z", "2026-11-05T12:00:00.000Z"]);
  expect(r({ range: "yesterday" })).toEqual(["yesterday", "2026-11-03T23:00:00.000Z", "2026-11-04T23:00:00.000Z"]);
  expect(r({ range: "24h" })).toEqual(["24h", "2026-11-04T12:00:00.000Z", "2026-11-05T12:00:00.000Z"]);
  expect(r({ range: "year" })).toEqual(["year", "2025-12-31T23:00:00.000Z", "2026-11-05T12:00:00.000Z"]);
  // A custom range holds both of its days whole; dates the wrong way round swap.
  expect(r({ range: "custom", from: "2026-10-15", to: "2026-10-01" })).toEqual(["custom", "2026-09-30T22:00:00.000Z", "2026-10-15T22:00:00.000Z"]);
  // A bad range, a custom range with a bad date, and a bad time zone fall back to the last 7 days in UTC.
  expect(r({ range: "custom", from: "nope", to: "2026-10-01" })[0]).toBe("7d");
  expect(r({ range: "forever" })[0]).toBe("7d");
  expect(resolveRange({ range: "today" }, now, "Not/AZone")).toMatchObject({ tz: "UTC", from: Date.parse("2026-11-05T00:00:00Z") });
});

test("bars are an hour up to two days, then a day, a week and a month, and weeks start on Monday", () => {
  const D = 86_400_000;
  expect([unitOf(D), unitOf(2 * D), unitOf(30 * D), unitOf(120 * D), unitOf(365 * D)]).toEqual(["hour", "hour", "day", "week", "month"]);
  expect(iso(bucketStart(now.getTime(), "Europe/Madrid", "week"))).toBe("2026-11-01T23:00:00.000Z");
  expect(iso(bucketStart(now.getTime(), "Europe/Madrid", "month"))).toBe("2026-10-31T23:00:00.000Z");
  // The day of the summer time change in Madrid is 23 hours long, and still one day.
  expect(iso(bucketStart(Date.parse("2026-03-29T20:00:00Z"), "Europe/Madrid", "day"))).toBe("2026-03-28T23:00:00.000Z");
});

test("a run counts in its bucket by what the decision said, and runs outside the range fall out", () => {
  const runs = [
    run("a", "2026-11-03T10:00:00Z", { endedAt: "2026-11-03T10:30:00Z", outcome: "done", costUsd: 2 }),
    run("b", "2026-11-04T10:00:00Z", { costUsd: 4 }),
    run("c", "2026-10-28T10:00:00Z", { endedAt: "2026-10-28T11:00:00Z", outcome: "blocked", lastStep: { step: "code-review", startedAt: "", ended: true, since: "" } }),
    run("old", "2026-01-01T10:00:00Z"),
  ];
  const events = [ev("a", "2026-11-03T10:20:00Z", "decision", "decision", { auto: true, reasons: [] }), ev("b", "2026-11-04T10:20:00Z", "decision", "decision", { auto: false, reasons: [] })];
  const r = resolveRange({ range: "custom", from: "2026-10-26", to: "2026-11-05" }, now, "UTC");
  const i = insights(runs, events, { from: r.from, to: r.to, now, tz: "UTC", budgets: { web: 10 } });
  expect(i.unit).toBe("day");
  expect(i.buckets).toHaveLength(11);
  expect(i.buckets.filter((b) => b.auto + b.person + b.stopped).map((b) => [b.label, b.auto, b.person, b.stopped])).toEqual([
    ["Oct 28", 0, 0, 1],
    ["Nov 3", 1, 0, 0],
    ["Nov 4", 0, 1, 0],
  ]);
  expect(i.runs).toBe(3);
  expect(i.time).toEqual({ p50: 1800, p95: 3600 }); // the open run b has no time yet
  expect(i.steps.find((s) => s.step === "code-review")?.blocked).toBe(1);
  // The week's cost is the current week's, whatever the range: a and b, not c.
  expect(i.targets).toEqual([{ target: "web", runs: 3, cost: 7, p50: 2, p95: 4, week: 6, budget: 10 }]);
});

test("a step's time runs from its start to its end, and a step that ran twice counts twice", () => {
  const runs = [run("a", "2026-11-05T10:00:00Z")];
  const events = [
    ev("a", "2026-11-05T10:00:00Z", "step_start", "code-review"),
    ev("a", "2026-11-05T10:01:00Z", "step_end", "code-review", { outcome: "next" }),
    ev("a", "2026-11-05T10:02:00Z", "step_start", "code-review"),
    ev("a", "2026-11-05T10:05:00Z", "step_end", "code-review", { outcome: "next" }),
    ev("a", "2026-11-05T10:06:00Z", "step_start", "verify"), // still running: reached, no time
  ];
  const r = resolveRange({ range: "today" }, now, "UTC");
  const i = insights(runs, events, { from: r.from, to: r.to, now, tz: "UTC" });
  expect(i.unit).toBe("hour");
  expect(i.steps.find((s) => s.step === "code-review")).toMatchObject({ reached: 1, p50: 60, p95: 180 });
  expect(i.steps.find((s) => s.step === "verify")).toMatchObject({ reached: 1, p50: 0 });
});
