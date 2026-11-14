import { expect, test } from "vitest";
import { buildRunOf, mergeMessage, runLine, withoutMarks } from "./change-text";
import { mergeReviewed } from "./merge";
import { fakeWorld } from "./test-helpers";

test("titles lose the [AM] mark and every skip-ci mark, also nested ones", () => {
  expect(withoutMarks("[AM] feat: x [skip ci]")).toBe("feat: x");
  expect(withoutMarks("fix: y [skip [ci skip]ci]")).toBe("fix: y");
  expect(withoutMarks("a [am]\nb")).toBe("a \nb");
  expect(mergeMessage("feat: x", "https://host.example/changes/5")).toBe("[AM] feat: x\nMerge request: https://host.example/changes/5");
});

test("the Factory run line reads back the build run, also from a body with \\r\\n lines", () => {
  const line = runLine("41", "https://ci.example/runs/41");
  expect(buildRunOf(`Intro\n\n${line}\n\nmore`)).toBe("41");
  expect(buildRunOf(`Intro\r\n${line}\r\nmore`)).toBe("41");
  expect(buildRunOf("No run line here")).toBeUndefined();
});

test("merge refuses when the change head differs from the reviewed head", async () => {
  const w = fakeWorld({ mrHead: "pushed-after-review", state: "running" });
  w.ctx.ci.vars.ticket = "8";
  w.openChange();
  expect(await mergeReviewed(w.ctx, "5", "head5", "[AM] m")).toEqual({ kind: "blocked", reason: expect.stringContaining("Someone pushed to change 5 after the review (head pushed-after-review, expected head5)") });
  expect(w.host.merged).toBe(false);
});

test("merge merges the reviewed head on green checks", async () => {
  const w = fakeWorld({ state: "running" });
  w.ctx.ci.vars.ticket = "8";
  w.openChange();
  expect(await mergeReviewed(w.ctx, "5", "head5", "[AM] m")).toBeUndefined();
  expect(w.host.mergedSha).toBe("head5");
});
