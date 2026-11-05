import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  list: [
    { run: "r1", target: "web", ticket: "7", startedAt: "2026-11-03T10:00:00Z", secs: 900, costUsd: 2, kind: "auto", round: 1, mergeRisk: 8, lastStep: "result-saved", bucket: "2026-11-02T00:00:00.000Z", stepSecs: { "code-review": 300 } },
    { run: "r2", target: "api", ticket: "9", startedAt: "2026-11-04T10:00:00Z", costUsd: 1, kind: "stopped", outcome: "blocked", lastStep: "code-review", round: 2, bucket: "2026-11-02T00:00:00.000Z", stepSecs: { "code-review": 60 } },
    { run: "r3", target: "web", ticket: "8", startedAt: "2026-11-04T11:00:00Z", costUsd: 1, kind: "open", bucket: "2026-11-02T00:00:00.000Z", stepSecs: { triage: 9 } },
  ],
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

test("a step opens the panel with the runs that reached it and their time in that step", () => {
  render(<InsightsView data={base} />);
  fireEvent.click(screen.getByRole("button", { name: /^Code review:/ }));
  const panel = screen.getByRole("dialog");
  expect(within(panel).getByText("Runs that reached Code review")).toBeTruthy();
  expect(within(panel).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/runs/r1", "/runs/r2"]);
  expect(within(panel).getByText("5 m")).toBeTruthy(); // r1's time in code review, not its 15 m run
  expect(within(panel).getByText("Blocked here")).toBeTruthy(); // r2 ended blocked at code review
});

test("a review rounds row and a target open their own runs", () => {
  render(<InsightsView data={base} />);
  fireEvent.click(screen.getByRole("button", { name: /^1 round/ }));
  expect(within(screen.getByRole("dialog")).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/runs/r1"]);
  fireEvent.click(screen.getByRole("button", { name: "api" }));
  expect(within(screen.getByRole("dialog")).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/runs/r2"]);
});

test("a page with no runs says so", () => {
  render(<InsightsView data={{ ...base, runs: 0 }} />);
  expect(screen.getByText("No run started in this range.")).toBeTruthy();
});
