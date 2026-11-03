import { fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { StepDetail } from "./step-detail";
import { ev, renderWithQuery } from "./test-utils";

afterEach(() => vi.unstubAllGlobals());

const start = ev("step_start", "00", { step: "precommit-gate", job: "42", data: { prompt: "Fix the bug" } });
const events = [
  ev("review_finding", "01", { data: { text: "Missing test", blocking: true, round: 1 } }),
  ev("gate_check", "01", { data: { command: "pnpm test", exitCode: 1, outputTail: "1 failed" } }),
  ev("rule_check", "01", { data: { rule: "no-secrets", passed: true, detail: "clean" } }),
  ev("jev_answer", "01", { data: { question: "Which API?", answer: "v2", confidence: "high" } }),
  ev("usage", "02", { data: { costUsd: 0.5 } }),
];

test("does not ask for the job log until the panel opens, then shows everything about the step", async () => {
  const fetchFn = vi.fn(async () => new Response("log line one"));
  vi.stubGlobal("fetch", fetchFn);
  renderWithQuery(<StepDetail start={start} events={events} />);
  expect(fetchFn).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  for (const text of ["Fix the bug", "Missing test", "pnpm test", "no-secrets: passed (clean)", "Which API? v2 (high)", "$0.50"]) {
    expect(document.body.textContent).toContain(text);
  }
  expect(fetchFn).toHaveBeenCalledWith("/api/jobs/42/log");
  expect(fetchFn).toHaveBeenCalledTimes(1);
});

test("a step without a CI job shows the log its step_end event sent, and asks nothing", async () => {
  const fetchFn = vi.fn();
  vi.stubGlobal("fetch", fetchFn);
  const local = ev("step_start", "00", { step: "triage", data: {} });
  const end = ev("step_end", "03", { step: "triage", data: { outcome: "next", log: "installed 12 packages" } });
  renderWithQuery(<StepDetail start={local} end={end} events={[]} />);
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Job log" }));
  expect(await screen.findByText("installed 12 packages")).toBeTruthy();
  expect(fetchFn).not.toHaveBeenCalled();
});
