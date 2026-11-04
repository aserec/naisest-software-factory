import { expect, test } from "vitest";
import { DEFAULT_THRESHOLDS, readThresholds } from "./thresholds";

test("a missing or blank file gives the defaults and no error", () => {
  expect(readThresholds(undefined)).toEqual({ values: DEFAULT_THRESHOLDS, errors: [] });
  expect(readThresholds("\n")).toEqual({ values: DEFAULT_THRESHOLDS, errors: [] });
});
test("a key that is set changes, a key that is missing keeps its default", () => {
  expect(readThresholds("diffRiskMax: 6\nmaxAgentRounds: 3\n")).toEqual({ values: { ...DEFAULT_THRESHOLDS, diffRiskMax: 6, maxAgentRounds: 3 }, errors: [] });
});
test.each([
  ["autoMergeConfidenceMin: 1.5", "autoMergeConfidenceMin", "autoMergeConfidenceMin must be a number from 0.5 to 1"],
  ["autoMergeConfidenceMin: 0.2", "autoMergeConfidenceMin", "autoMergeConfidenceMin must be a number from 0.5 to 1"],
  ['clarityMin: "6"', "clarityMin", "clarityMin must be a whole number from 2 to 10"],
  ["maxAgentRounds: 0", "maxAgentRounds", "maxAgentRounds must be a whole number from 1 to 10"],
  ["diffRiskMax: 4.5", "diffRiskMax", "diffRiskMax must be a whole number from 2 to 10"],
])("a bad value in %s keeps the default and names the key", (text, key, message) => {
  const r = readThresholds(text);
  expect(r.values).toEqual(DEFAULT_THRESHOLDS);
  expect(r.errors).toEqual([`.factory/thresholds.yml: ${message}`]);
  expect(r.errors[0]).toContain(key);
});
test("an unknown key is an error, so a typo never passes quietly", () => {
  expect(readThresholds("diffRiskmax: 3")).toEqual({ values: DEFAULT_THRESHOLDS, errors: [".factory/thresholds.yml: unknown key diffRiskmax"] });
});
test("a key given twice fails closed with one error", () => {
  const r = readThresholds("clarityMin: 8\nclarityMin: 3");
  expect(r.values).toEqual(DEFAULT_THRESHOLDS);
  expect(r.errors).toEqual([expect.stringContaining("is not valid YAML")]);
});
test("a good key next to a bad key still applies", () => {
  const r = readThresholds("clarityMin: 8\nmaxAgentRounds: 99");
  expect(r.values).toEqual({ ...DEFAULT_THRESHOLDS, clarityMin: 8 });
  expect(r.errors).toHaveLength(1);
});
test.each(["- 1\n- 2", "a: [1", "just text"])("text that is not a YAML map (%j) gives the defaults and one error", (text) => {
  const r = readThresholds(text);
  expect(r.values).toEqual(DEFAULT_THRESHOLDS);
  expect(r.errors).toHaveLength(1);
  expect(r.errors[0]).toContain(".factory/thresholds.yml");
});
