import { expect, test } from "vitest";
import { DEFAULT_THRESHOLDS, checkThresholds } from "./thresholds";

test("no settings give the defaults and no error", () => {
  expect(checkThresholds(undefined)).toEqual({ values: DEFAULT_THRESHOLDS, errors: [] });
  expect(checkThresholds({})).toEqual({ values: DEFAULT_THRESHOLDS, errors: [] });
});
test("a key that is set changes, a key that is missing keeps its default", () => {
  expect(checkThresholds({ diffRiskMax: 6, maxAgentRounds: 3, autoMergeTriageMax: "trivial" })).toEqual({ values: { ...DEFAULT_THRESHOLDS, diffRiskMax: 6, maxAgentRounds: 3, autoMergeTriageMax: "trivial" }, errors: [] });
});
test.each([
  [{ autoMergeConfidenceMin: 1.5 }, "autoMergeConfidenceMin must be a number from 0.5 to 1"],
  [{ autoMergeConfidenceMin: 0.2 }, "autoMergeConfidenceMin must be a number from 0.5 to 1"],
  [{ clarityMin: "6" }, "clarityMin must be a whole number from 2 to 10"],
  [{ maxAgentRounds: 0 }, "maxAgentRounds must be a whole number from 1 to 10"],
  [{ diffRiskMax: 4.5 }, "diffRiskMax must be a whole number from 2 to 10"],
  [{ autoMergeTriageMax: "medium" }, "autoMergeTriageMax must be one of trivial, low"],
])("a bad value in %j keeps the default and names the key", (doc, message) => {
  const r = checkThresholds(doc);
  expect(r.values).toEqual(DEFAULT_THRESHOLDS);
  expect(r.errors).toEqual([`Settings: ${message}`]);
});
test("an unknown key is an error, so a typo never passes quietly", () => {
  expect(checkThresholds({ diffRiskmax: 3 })).toEqual({ values: DEFAULT_THRESHOLDS, errors: ["Settings: unknown threshold diffRiskmax"] });
});
test("a good key next to a bad key still applies", () => {
  const r = checkThresholds({ clarityMin: 8, maxAgentRounds: 99 });
  expect(r.values).toEqual({ ...DEFAULT_THRESHOLDS, clarityMin: 8 });
  expect(r.errors).toHaveLength(1);
});
test.each([[[1, 2]], ["just text"], [5]])("a value that is not a map (%j) gives the defaults and one error", (doc) => {
  expect(checkThresholds(doc)).toEqual({ values: DEFAULT_THRESHOLDS, errors: ["The thresholds setting is not a map"] });
});
