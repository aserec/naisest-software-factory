import { expect, test } from "vitest";
import { askRisk, decideMerge } from "./decision";
import type { JevClient } from "./jev";
import type { Risk } from "./types";

const ok = { triageRisk: "low" as Risk, reviewPassed: true, gateGreen: true, rules: [], risk: { diffRisk: { value: 4, confidence: 0.9 }, scopeYes: 0.9, sensitiveYes: 0.1 } };
test("all four conditions met merges alone", () => expect(decideMerge(ok)).toEqual({ kind: "auto" }));
test("medium triage risk always waits", () => expect(decideMerge({ ...ok, triageRisk: "medium" }).kind).toBe("needs_approval"));
test("diff risk 5 waits and says why", () => expect(decideMerge({ ...ok, risk: { ...ok.risk, diffRisk: { value: 5, confidence: 0.95 } } })).toEqual({ kind: "needs_approval", reasons: [expect.stringContaining("diff_risk")] }));
test("diff risk 4 at confidence 0.89 waits", () => expect(decideMerge({ ...ok, risk: { ...ok.risk, diffRisk: { value: 4, confidence: 0.89 } } }).kind).toBe("needs_approval"));
test("sensitive at P(no) 0.89 waits", () => expect(decideMerge({ ...ok, risk: { ...ok.risk, sensitiveYes: 0.11 } }).kind).toBe("needs_approval"));
test("a failed hard rule is named in the reasons", () => expect(decideMerge({ ...ok, rules: [{ rule: "size", passed: false, detail: "412 lines" }] })).toMatchObject({ reasons: [expect.stringContaining("size")] }));
test("every failed condition is listed", () => {
  const d = decideMerge({ ...ok, reviewPassed: false, gateGreen: false, risk: { ...ok.risk, scopeYes: 0.5 } });
  expect(d).toMatchObject({ kind: "needs_approval", reasons: [expect.stringContaining("review"), expect.stringContaining("gate"), expect.stringContaining("scope")] });
});
test("a NaN answer waits", () => expect(decideMerge({ ...ok, risk: { ...ok.risk, scopeYes: NaN } }).kind).toBe("needs_approval"));

test("askRisk maps answers and cuts the diff to 8000 characters", async () => {
  let seen: any;
  const jev: JevClient = { provider: "mock", async ask(state) { seen = state; return [
    { id: "diff_risk", value: 3, probability: 0.5, confidence: 0.95 },
    { id: "scope", value: true, probability: 0.97, confidence: 0.9 },
    { id: "sensitive", value: false, probability: 0.02, confidence: 0.9 },
  ]; } };
  expect(await askRisk(jev, { title: "t", description: "d" }, "x".repeat(9000))).toEqual({ diffRisk: { value: 3, confidence: 0.95 }, scopeYes: 0.97, sensitiveYes: 0.02 });
  expect(seen.diff).toHaveLength(8000);
});
test("askRisk throws when an answer is missing", async () => {
  const jev: JevClient = { provider: "mock", async ask() { return []; } };
  await expect(askRisk(jev, { title: "t", description: "d" }, "")).rejects.toThrow("diff_risk");
});
