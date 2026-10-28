import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { makeContext, runStep } from "./context";
import { BOT, B, fakeWorld, mrEvent, runBuildPipeline, runFinishPipeline } from "./test-helpers";

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

// Spec 6.7: approval and manual merge.
test("a developer's approval of a waiting MR starts the finish pipeline with the build record", async () => {
  const w = await runBuildPipeline(fakeWorld({ payload: mrEvent("approved"), liveLabels: ["factory_needs_approval"] }));
  expect(w.finishVars).toMatchObject({ FACTORY_PIPELINE: "finish", FACTORY_WORK_ITEM_IID: "8", FACTORY_MR_IID: "5", FACTORY_BUILD_PIPELINE_ID: "41" });
  expect(w.finishVars.FACTORY_SKIP_APPLY).toBeUndefined();
  expect(w.labels).toEqual(["factory_running"]);
  expect(w.claudeCalls).toBe(0);
});
test("a manual merge starts the finish pipeline with apply skipped", async () => {
  const w = await runBuildPipeline(fakeWorld({ payload: mrEvent("merge"), liveLabels: ["factory_needs_approval"] }));
  expect(w.finishVars).toMatchObject({ FACTORY_MR_IID: "5", FACTORY_SKIP_APPLY: "1" });
});
test("approvals by the bot or a non-developer, or of an MR not waiting for a person, start nothing", async () => {
  for (const o of [
    { payload: mrEvent("merge", BOT), liveLabels: ["factory_needs_approval"] },
    { payload: mrEvent("approved"), liveLabels: ["factory_needs_approval"], actorLevel: 20 },
    { payload: mrEvent("approved"), liveLabels: ["factory_running"] },
  ]) expect((await runBuildPipeline(fakeWorld(o))).finishTriggered).toBe(false);
});
test("finish after a manual merge does not merge again and verifies the merge commit", async () => {
  const w = await runFinishPipeline(fakeWorld({ mrState: "merged", defaultBranch: "master" }), { decision: "needs_approval", skipApply: true });
  expect(w.merged).toBe(false);
  expect(w.record.steps.find((s) => s.step === "apply")?.data).toMatchObject({ sha: "manual789", skipped: true });
  expect(w.labels).toEqual(["factory_done"]);
});

// Apply's merge rule.
test("finish for an MR that needs approval and has none does not merge", async () => {
  const w = await runFinishPipeline(fakeWorld({ approvedBy: [] }), { decision: "needs_approval" });
  expect(w.merged).toBe(false);
  expect(w.labels).toEqual(["factory_blocked"]);
});
test("a bot approval does not count; a person's approval merges the reviewed commit", async () => {
  expect((await runFinishPipeline(fakeWorld({ approvedBy: [BOT] }), { decision: "needs_approval" })).merged).toBe(false);
  const w = await runFinishPipeline(fakeWorld({ approvedBy: [42] }), { decision: "needs_approval" });
  expect(w.merged).toBe(true);
  expect(w.mergedSha).toBe("head5");
});
test("the auto path merges the reviewed commit and posts the decision on the MR", async () => {
  const b = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" } }));
  expect(b.mrComments.at(-1)).toContain("without a person");
  expect(b.finishVars.FACTORY_BUILD_PIPELINE_ID).toBe("1");
  expect(b.record.steps.find((s) => s.step === "risk-check")?.data).toMatchObject({ headSha: "head5" });
  expect((await runFinishPipeline(fakeWorld())).mergedSha).toBe("head5");
});

// Re-run.
test("a re-run reuses the open MR of the factory branch", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, existingMr: true }));
  expect(w.mrOpened).toBe(false);
  expect(w.record.steps.find((s) => s.step === "precommit-gate")?.data).toMatchObject({ mrIid: 5 });
});

// Minor fixes.
test("a block after the merge reopens the work item", async () => {
  const w = await runFinishPipeline(fakeWorld({ mainPipeline: "failed" }));
  expect(w.closed).toBe(false);
});
test("verify blocks when .factory.yml names a smoke test", async () => {
  const w = await runFinishPipeline(fakeWorld(), { smoke: "pnpm test:smoke" });
  expect(w.labels).toEqual(["factory_blocked"]);
  expect(w.workItemComments.at(-1)).toContain("smoke");
});

// runStep, the CI job body.
const tmp = () => mkdtempSync(join(tmpdir(), "runstep-"));
test("runStep skips when an earlier job stopped the run", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "stop"), "event");
  let ran = false;
  await runStep("triage", async () => ((ran = true), "next"), { dir, make: () => fakeWorld().ctx });
  expect(ran).toBe(false);
});
test("runStep saves the record and writes the stop file on a stop", async () => {
  const dir = tmp();
  const w = fakeWorld({ liveLabels: ["factory_ready", "factory_running"] });
  await runStep("event", (await import("./event")).run, { dir, make: () => w.ctx });
  expect(readFileSync(join(dir, "stop"), "utf8")).toBe("event");
  expect(JSON.parse(readFileSync(join(dir, "record.json"), "utf8")).steps[0].step).toBe("event");
});
test("runStep blocks the work item on an unexpected error and still fails the job", async () => {
  const dir = tmp();
  const w = fakeWorld();
  w.ctx.env.workItemIid = 8;
  await expect(runStep("code-review", async () => { throw new Error("reviewer crashed"); }, { dir, make: () => w.ctx })).rejects.toThrow("reviewer crashed");
  expect(w.labels).toEqual(["factory_blocked"]);
  expect(w.workItemComments.at(-1)).toContain("reviewer crashed");
  expect(existsSync(join(dir, "record.json"))).toBe(true);
});
test("finish waits for the build record, then blocks with the env work item if it never comes", async () => {
  const dir = tmp();
  let tries = 0;
  const w = fakeWorld();
  w.ctx.env = { ...w.ctx.env, payload: undefined, workItemIid: 8, mrIid: 5, buildPipelineId: 41, factoryProjectId: 3 };
  w.ctx.gitlab.buildRecord = async () => { tries++; throw new Error("GitLab GET failed with status 404"); };
  let ran = false;
  await expect(runStep("apply", async () => ((ran = true), "next"), { dir, make: () => w.ctx })).rejects.toThrow(/build pipeline 41/);
  expect(tries).toBeGreaterThan(1);
  expect(ran).toBe(false);
  expect(w.labels).toEqual(["factory_blocked"]);
});
test("finish loads the build record once it is uploaded", async () => {
  const dir = tmp();
  const w = fakeWorld();
  w.ctx.env = { ...w.ctx.env, buildPipelineId: 41, factoryProjectId: 3 };
  let tries = 0;
  w.ctx.gitlab.buildRecord = async () => {
    if (++tries < 3) throw new Error("GitLab GET failed with status 404");
    return { ...w.ctx.record, workItem: "from-build" };
  };
  let seen = "";
  await runStep("apply", async (ctx) => ((seen = ctx.record.workItem), "next"), { dir, make: () => w.ctx });
  expect(seen).toBe("from-build");
});

test("makeContext reads the secret files into memory and deletes them", () => {
  const dir = tmp();
  const file = (name: string, v: string) => (writeFileSync(join(dir, name), `${v}\n`), join(dir, name));
  const env = { CI_SERVER_URL: "https://gl", FACTORY_TARGET: "react_frontend", BERGET_API_KEY: "k",
    FACTORY_GITLAB_TOKEN: file("gl", "glpat-x"), TEAMS_WEBHOOK_URL: file("teams", "https://t"), FACTORY_TRIGGER_TOKEN: file("trig", "tt") };
  makeContext(env);
  for (const k of ["gl", "teams", "trig"]) expect(existsSync(join(dir, k))).toBe(false);
  const err = (() => { try { makeContext({ ...env, FACTORY_GITLAB_TOKEN: "glpat-raw-value" }); } catch (e) { return String(e); } })();
  expect(err).toContain("must be a File type CI variable");
  expect(err).not.toContain("glpat-raw-value");
});
