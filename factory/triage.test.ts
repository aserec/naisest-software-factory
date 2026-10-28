import { expect, test, vi } from "vitest";
import { makeJevClient } from "./jev";
import { askTriage, buildTriageState, decideTriage, type TriageAnswers } from "./triage";

const base: TriageAnswers = { injectionYes: 0.05, type: { value: "bug", confidence: 0.9 }, risk: { value: "low", confidence: 0.9 }, clarity: { value: 8, confidence: 0.9 }, effort: { value: 3, confidence: 0.9 } };
test("injection at 0.3 blocks", () => expect(decideTriage({ ...base, injectionYes: 0.3 }).kind).toBe("blocked"));
test("clarity 5 asks questions", () => expect(decideTriage({ ...base, clarity: { value: 5, confidence: 0.9 } })).toEqual({ kind: "needs_info" }));
test("unsure low risk becomes medium", () => expect(decideTriage({ ...base, risk: { value: "low", confidence: 0.6 } })).toEqual({ kind: "build", risk: "medium", effort: 3 }));
test("unsure high risk stays high", () => expect(decideTriage({ ...base, risk: { value: "high", confidence: 0.5 } })).toMatchObject({ risk: "high" }));
test("long descriptions are cut to 8000 characters", () => expect(buildTriageState("t", "x".repeat(20000), []).description).toHaveLength(8000));
test("empty description ends in needs_info with the mock", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const a = await askTriage(makeJevClient({}), buildTriageState("t", "", []));
  expect(decideTriage(a).kind).toBe("needs_info");
});
test("a described ticket builds with the mock", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const a = await askTriage(makeJevClient({}), buildTriageState("t", "Fix the button", []));
  expect(decideTriage(a)).toEqual({ kind: "build", risk: "trivial", effort: 7 });
});
