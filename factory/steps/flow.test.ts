import { expect, test } from "vitest";
import { B, fakeWorld, runBuildPipeline, runFinishPipeline } from "./test-helpers";

test("trivial ticket: build pipeline ends in auto-merge with no person", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, reviews: [[]], gate: "green", jev2: "pass" }));
  expect(w.labels).toEqual(["factory_running"]);
  expect(w.finishTriggered).toBe(true);
  expect(w.cards).toHaveLength(0);
});
test("medium ticket: stops at decision with reasons on the MR and a Teams card", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "medium" }, reviews: [[]], gate: "green", jev2: "pass" }));
  expect(w.labels).toEqual(["factory_needs_approval"]);
  expect(w.mrComments.at(-1)).toContain("risk");
  expect(w.cards.map(c => c.kind)).toEqual(["needs_approval"]);
});
test("usage limit mid-run labels factory_waiting and keeps the session", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "low" }, prepare: "limit" }));
  expect(w.labels).toEqual(["factory_waiting"]);
  expect(w.record.steps.at(-1)).toMatchObject({ step: "prepare-patch", data: { sessionId: expect.any(String) } });
});
test("finish pipeline merges, waits for the default branch and closes the work item", async () => {
  const w = await runFinishPipeline(fakeWorld({ mainPipeline: "success", defaultBranch: "master" }));
  expect(w.mainPipelineRef).toBe("master");
  expect(w.labels).toEqual(["factory_done"]);
  expect(w.closed).toBe(true);
  expect(w.cards.map(c => c.kind)).toEqual(["done"]);
});
test("injection at triage blocks, assigns a person and sends one card", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { injectionYes: 0.4 } }));
  expect(w.labels).toEqual(["factory_blocked"]);
  expect(w.assigned).toBe(true);
  expect(w.cards.map(c => c.kind)).toEqual(["blocked"]);
  expect(w.claudeCalls).toBe(0);
});
test("three failed review rounds block with the open findings posted", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "low" }, reviews: [[B], [B], [B]] }));
  expect(w.labels).toEqual(["factory_blocked"]);
  expect(w.workItemComments.at(-1)).toContain(B.text);
});
test("a red main pipeline opens a revert MR and blocks", async () => {
  const w = await runFinishPipeline(fakeWorld({ mainPipeline: "failed", defaultBranch: "master" }));
  expect(w.revertOpened).toBe(true);
  expect(w.labels).toEqual(["factory_blocked"]);
});

// Controller rulings.
test("event reads live labels: an active run on the work item stops quietly", async () => {
  const w = await runBuildPipeline(fakeWorld({ liveLabels: ["factory_ready", "factory_needs_approval"] }));
  expect(w.record.steps.map((s) => s.step)).toEqual(["event"]);
  expect(w.record.steps[0].data).toMatchObject({ start: false, reason: "active-run" });
  expect(w.workItemComments).toHaveLength(0);
});
test("a Jev failure at triage blocks with the error and a card", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: "throw" }));
  expect(w.labels).toEqual(["factory_blocked"]);
  expect(w.workItemComments.at(-1)).toContain("HTTP 503");
  expect(w.cards.map((c) => c.kind)).toEqual(["blocked"]);
  expect(w.claudeCalls).toBe(0);
});
test("a Jev failure at the risk check sends the change to a person with the error", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, jev2: "throw" }));
  expect(w.finishTriggered).toBe(false);
  expect(w.labels).toEqual(["factory_needs_approval"]);
  expect(w.mrComments.at(-1)).toContain("HTTP 503");
});
test("unreadable numstat fails the hard rules and sends the change to a person", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, numstat: "garbage\0" }));
  expect(w.finishTriggered).toBe(false);
  expect(w.labels).toEqual(["factory_needs_approval"]);
  expect(w.mrComments.at(-1)).toContain("Bad numstat");
});
test("a red merge request pipeline sends the change to a person", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, mrPipeline: "failed" }));
  expect(w.finishTriggered).toBe(false);
  expect(w.mrComments.at(-1)).toContain("pipeline");
});
test("apply does not merge while the merge request pipeline is not green", async () => {
  const w = await runFinishPipeline(fakeWorld({ mrPipeline: "failed" }));
  expect(w.merged).toBe(false);
  expect(w.labels).toEqual(["factory_blocked"]);
});
test("the MR closes the work item and carries the reason for a changed test", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, testChanges: "Updated the List snapshot for the spinner." }));
  expect(w.mrDescription).toContain("Closes #8");
  expect(w.mrDescription).toContain("Updated the List snapshot for the spinner.");
});
test("unclear ticket: questions are posted and the label is needs_info", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { clarity: 4 } }));
  expect(w.labels).toEqual(["factory_needs_info"]);
  expect(w.workItemComments.at(-1)).toContain("1. Which list?");
  expect(w.cards.map((c) => c.kind)).toEqual(["needs_info"]);
});
