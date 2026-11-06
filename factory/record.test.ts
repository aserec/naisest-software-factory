import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { addStep, formatResult, loadRecord, newRecord, runFacts, saveRecord, type RequestRound, type RunRecord } from "./record";

const sampleRecord: RunRecord = {
  workItem: "react_frontend#8",
  startedAt: "2026-10-28T12:00:00Z",
  steps: [
    { step: "triage", at: "2026-10-28T12:01:00Z", data: { clarity: 8 } },
    { step: "risk-check", at: "2026-10-28T12:20:00Z", data: { diff_risk: 3 } },
  ],
  models: { author: "claude-sonnet-5-5", reviewer: "tensorx-deepseek-small" },
  rounds: { review: 2, gate: 1 },
  costUsd: 0.42,
  tokens: { input: 1200, output: 340 },
  summary: "Fixed the button",
};

test("the result lists links, Jev answers, models, rounds, cost and time", () => {
  const text = formatResult(sampleRecord, "https://mr", "https://pl", new Date("2026-10-28T12:30:00Z"));
  for (const part of ["https://mr", "https://pl", "claude-sonnet-5-5", "review rounds: 2", "gate rounds: 1", "$0.42", "30 min", '"clarity":8', '"diff_risk":3', "What changed: Fixed the button", "Tokens: 1200 in, 340 out"])
    expect(text).toContain(part);
});
test("addStep returns a new record and saveRecord/loadRecord round-trip", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "rec-")), "run");
  const next = addStep(sampleRecord, "apply", { ok: true });
  expect(sampleRecord.steps).toHaveLength(2);
  expect(next.steps).toHaveLength(3);
  saveRecord(next, dir);
  expect(loadRecord(dir)).toEqual(next);
});
test("a bad start time and missing steps are shown plainly", () => {
  const text = formatResult({ ...sampleRecord, startedAt: "nope", steps: [] }, "m", "p", new Date());
  expect(text).toContain("Time: unknown");
  expect(text).toContain("triage: did not run");
  expect(text).toContain("risk-check: did not run");
});

test("runFacts reports an open round and a round start", () => {
  const round: RequestRound = { cursor: "t", requests: [], costAtStart: 0, tokensAtStart: { input: 0, output: 0 } };
  let r = addStep(newRecord(), "event", { start: true });
  expect(runFacts(r)).toMatchObject({ roundStart: false, openRound: undefined, requested: false });
  r = { ...addStep(r, "event", { round: 1 }), requestRounds: [{ ...round, endedAt: "x" }, round] };
  expect(runFacts(r)).toMatchObject({ roundStart: true, openRound: round, requested: true });
  r = { ...addStep(r, "questions", {}), requestRounds: [{ ...round, endedAt: "x" }] };
  expect(runFacts(r)).toMatchObject({ roundStart: false, openRound: undefined, requested: true });
});
test("a conflict round alone is no request: the run may still merge without a person", () => {
  const conflict: RequestRound = { cursor: "t", requests: [], conflicts: true, costAtStart: 0, tokensAtStart: { input: 0, output: 0 } };
  expect(runFacts({ ...newRecord(), requestRounds: [conflict] }).requested).toBe(false);
});
