import { screen } from "@testing-library/react";
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

test("shows everything about the step and asks GitLab for its job log once", async () => {
  const fetchFn = vi.fn(async () => new Response("log line one"));
  vi.stubGlobal("fetch", fetchFn);
  renderWithQuery(<StepDetail start={start} events={events} />);
  expect(await screen.findByText("log line one")).toBeTruthy();
  for (const text of ["Fix the bug", "Missing test", "Blocking", "pnpm test", "exit 1", "no-secrets", "clean", "Which API?", "v2 · high confidence", "$0.50"]) {
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
  expect(await screen.findByText("installed 12 packages")).toBeTruthy();
  expect(fetchFn).not.toHaveBeenCalled();
});

test("a decision shows its reasons as a list, the merge risk and the change, and keeps the log closed", async () => {
  vi.stubGlobal("fetch", vi.fn());
  const step = ev("step_start", "00", { step: "decision", data: {} });
  const end = ev("step_end", "03", { step: "decision", data: { outcome: "stop", log: "[chat needs_approval] title" } });
  const decision = ev("decision", "01", { step: "decision", data: { auto: false, reasons: ["hard rule size failed: 1538 lines", "no proof: no proof.json"], risk: 6, riskMax: 4, changeUrl: "https://example.com/pull/441" } });
  renderWithQuery(<StepDetail start={step} end={end} events={[decision]} />);
  const items = [...document.querySelectorAll("li")].map((li) => li.textContent);
  expect(items).toEqual(["Hard rule size failed: 1538 lines", "No proof: no proof.json"]);
  expect(document.body.textContent).toContain("6 of 10, the limit is 4");
  expect(screen.getByRole("link", { name: "https://example.com/pull/441" })).toBeTruthy();
  expect(document.querySelector("details")?.open).toBe(false);
  expect(document.body.textContent).toContain("None, no model ran in this step");
});

test("a model with no price shows its cost is missing, not just $0.00", () => {
  vi.stubGlobal("fetch", vi.fn());
  const usage = ev("usage", "02", { data: { model: "glm-flash", input: 900, output: 40, costUsd: 0 } });
  renderWithQuery(<StepDetail start={start} events={[usage]} />);
  expect(document.body.textContent).toContain("Without glm-flash: seams.yml sets no price for it");
});
