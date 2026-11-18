import { expect, test } from "vitest";
import { checkModelPicks, type Effort } from "./model-picks";

const models = { opus: "opus", sonnet: "sonnet" };
const row = { author: { harness: "claude-code", model: "opus", effort: "medium" as Effort }, reviewer: { harness: "claude-code", model: "opus", effort: "xhigh" as Effort } };
const check = (raw: unknown) => checkModelPicks(raw, row, { author: models, reviewer: models });

test("no picks keep the router row", () => expect(check(undefined)).toEqual({ row, errors: [] }));
test("a pick changes the model and effort and keeps the harness", () =>
  expect(check({ author: { model: "sonnet", effort: "high" } }).row.author).toEqual({ harness: "claude-code", model: "sonnet", effort: "high" }));
test("a model the provider does not list or a bad effort keeps the router row", () => {
  for (const bad of [{ author: { model: "gpt", effort: "high" } }, { reviewer: { model: "opus", effort: "max" } }, { writer: { model: "opus", effort: "high" } }, "opus"]) {
    const r = check(bad);
    expect(r.row).toBe(row);
    expect(r.errors).toHaveLength(1);
  }
});
test("the same family at the same effort is refused", () =>
  expect(check({ reviewer: { model: "opus", effort: "medium" } })).toEqual({ row, errors: ["Settings: author and reviewer are both family opus at effort medium"] }));
