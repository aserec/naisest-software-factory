import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { Insights } from "@/server/insights";
import { InsightsView } from "./insights-view";

afterEach(cleanup);

const base: Insights = {
  unit: "week",
  buckets: [{ start: "2026-11-02T00:00:00.000Z", label: "Nov 2", auto: 3, person: 1, stopped: 2 }],
  runs: 6,
  cost: { p50: 1.5, p95: 4, total: 12 },
  time: { p50: 600, p95: 1800 },
  steps: [{ step: "code-review", reached: 6, blocked: 2, p50: 60, p95: 300 }],
  targets: [
    { target: "web", runs: 4, cost: 9, p50: 2, p95: 4, week: 9, budget: 10 },
    { target: "api", runs: 2, cost: 3, p50: 1, p95: 2, week: 3 },
  ],
  rounds: [{ n: 1, count: 4 }],
  risk: [{ run: "r1", risk: 8, max: 6, kind: "auto" }],
};

test("the figures say what merged alone and what a run costs", () => {
  render(<InsightsView data={base} />);
  expect(screen.getByText("75%")).toBeTruthy(); // 3 of the 4 decided changes merged alone
  expect(screen.getByText("of 4 decided changes")).toBeTruthy();
  expect(screen.getByText("$1.50")).toBeTruthy();
  expect(screen.getByLabelText(/3 merged without a person, 1 sent to a person, 2 ended without a change/)).toBeTruthy();
});

test("a week's cost turns to a warning from 80% of its budget, and a target with no budget shows only its cost", () => {
  render(<InsightsView data={base} />);
  expect(screen.getByTitle("90% of the weekly budget").className).toContain("text-pill-warning-ink");
  cleanup();
  render(<InsightsView data={{ ...base, targets: [{ ...base.targets[0], week: 11 }, base.targets[1]] }} />);
  expect(screen.getByTitle("110% of the weekly budget").className).toContain("text-destructive");
  expect(screen.getAllByText("$3.00").length).toBeGreaterThan(0);
});

test("the line gives each step its runs, its blocks and its times", () => {
  render(<InsightsView data={base} />);
  expect(screen.getByLabelText("Code review: reached by 6, 2 blocked here, 1 m on a usual run, 5 m on a slow one")).toBeTruthy();
  expect(screen.getByText("2 blocked").className).toContain("text-destructive");
});

test("a page with no runs says so", () => {
  render(<InsightsView data={{ ...base, runs: 0 }} />);
  expect(screen.getByText("No run started in this range.")).toBeTruthy();
});
