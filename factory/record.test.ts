import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { addStep, formatResult, loadRecord, saveRecord, type RunRecord } from "./record";

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
};

test("the result lists links, Jev answers, models, rounds, cost and time", () => {
  const text = formatResult(sampleRecord, "https://mr", "https://pl", new Date("2026-10-28T12:30:00Z"));
  for (const part of ["https://mr", "https://pl", "claude-sonnet-5-5", "review rounds: 2", "gate rounds: 1", "$0.42", "30 min", '"clarity":8', '"diff_risk":3'])
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
