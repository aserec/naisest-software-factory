// Fake world for the step flow tests. Every outside call is an in-memory fake that records what the steps did.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaudeResult, ClaudeRun, Finding } from "../agents";
import { loadRouter, loadTarget } from "../config";
import { STATE_LABELS, type GitLab } from "../gitlab";
import type { JevAnswer, JevClient } from "../jev";
import { addStep } from "../record";
import type { Risk } from "../types";
import { newRecord, runStep, waitingNote, type Repo, type StepContext } from "./context";
import * as event from "./event";
import * as triage from "./triage";
import * as preparePatch from "./prepare-patch";
import * as codeReview from "./code-review";
import * as precommitGate from "./precommit-gate";
import * as riskCheck from "./risk-check";
import * as decision from "./decision";
import * as apply from "./apply";
import * as verify from "./verify";
import * as resultSaved from "./result-saved";

export const B: Finding = { blocking: true, file: "src/List.tsx", text: "the list never shows the spinner" };

export interface WorldOptions {
  jev1?: { risk?: Risk; injectionYes?: number; clarity?: number } | "throw";
  jev2?: "pass" | "throw";
  reviews?: Finding[][];
  gate?: "green" | "red";
  prepare?: "ok" | "limit";
  fixLimit?: boolean; // the first fix run hits the usage limit
  factoryFile?: string; // .factory.yml in the clone
  numstat?: string;
  diffText?: string;
  testChanges?: string;
  liveLabels?: string[];
  payload?: unknown;
  actorLevel?: number;
  approvedBy?: number[];
  mrState?: string;
  existingMr?: boolean;
  mrPipeline?: "success" | "failed";
  mainPipeline?: "success" | "failed";
  defaultBranch?: string;
  title?: string; // the work item title
}

export const BOT = 1;
export const mrEvent = (action: "approved" | "merge", actorId = 42) => ({
  object_kind: "merge_request",
  user: { id: actorId },
  project: { path_with_namespace: "acme/web/react_frontend" },
  object_attributes: { iid: 5, action, source_branch: "factory/8-add-a-loading-state" },
});
const KINDS: Record<string, string> = { "Needs info": "needs_info", "Needs approval": "needs_approval", Blocked: "blocked", Done: "done" };
const payload = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/label-added.json", import.meta.url)), "utf8"));
const ok = (sessionId: string, extra: Partial<ClaudeResult> = {}): ClaudeResult => ({ sessionId, isError: false, limitHit: false, costUsd: 0.1, tokens: { input: 100, output: 20 }, resultText: "1. Which list?", ...extra });

export function fakeWorld(o: WorldOptions = {}) {
  const reviews = [...(o.reviews ?? [[]])];
  const w = {
    stateLabels: [...(o.liveLabels ?? ["factory_ready"])],
    workItemComments: [] as string[],
    mrComments: [] as string[],
    mrDescription: "",
    mrTitle: "",
    commitMessage: "",
    mrOpened: false,
    mergedSha: "",
    cards: [] as { kind: string; card: any }[],
    assigned: false,
    closed: false,
    merged: false,
    revertOpened: false,
    finishTriggered: false,
    finishVars: {} as Record<string, string>,
    claudeCalls: 0,
    claudeRuns: [] as ClaudeRun[],
    jevAsked: 0,
    restored: [] as number[],
    ran: [] as string[],
    reviewsRun: 0,
    mainPipelineRef: "",
    ctx: undefined as unknown as StepContext,
    get labels() {
      return this.stateLabels.filter((l) => (STATE_LABELS as readonly string[]).includes(l));
    },
    get record() {
      return this.ctx.record;
    },
  };

  const gitlab: Partial<GitLab> = {
    getProject: async () => ({ id: 7, defaultBranch: o.defaultBranch ?? "main" }),
    getWorkItem: async () => ({ title: o.title ?? "Add a loading state", description: "Show a spinner while the list loads.", labels: [...w.stateLabels], assigneeIds: [], webUrl: "https://gitlab.test/work_items/8", state: w.closed ? "closed" : "opened" }),
    reopenWorkItem: async () => void (w.closed = false),
    botUserId: async () => BOT,
    memberAccessLevel: async () => o.actorLevel ?? 30,
    countLabeled: async () => 0,
    labelAddedBy: async () => 42,
    setState: async (_p, _i, label) => void (w.stateLabels = [...w.stateLabels.filter((l) => !(STATE_LABELS as readonly string[]).includes(l)), label]),
    comment: async (_p, _i, body) => void w.workItemComments.push(body),
    commentMergeRequest: async (_p, _i, body) => void w.mrComments.push(body),
    userId: async () => 99,
    assignWorkItem: async () => void (w.assigned = true),
    assignMergeRequest: async () => void (w.assigned = true),
    upsertMergeRequest: async (_p, _b, _t, title, description) => ((w.mrTitle = title), (w.mrDescription = description), (w.mrOpened = !o.existingMr), { iid: 5, webUrl: "https://gitlab.test/merge_requests/5" }),
    getMergeRequest: async () => ({ state: o.mrState ?? "opened", description: "Factory run: https://gitlab.test/pipelines/41", headSha: "head5", mergeSha: "manual789" }),
    approvedBy: async () => o.approvedBy ?? [],
    // Only the reviewed head counts. A caller that passes another sha never sees green.
    mergeRequestPipelineStatus: async (_p, _i, sha) => (sha === "head5" ? (o.mrPipeline ?? "success") : "running"),
    // Merging closes the work item, as "Closes #8" does in GitLab.
    merge: async (_p, _i, sha) => ((w.merged = true), (w.mergedSha = sha), (w.closed = true), "abc123def456"),
    pipelineStatus: async (_p, ref) => ((w.mainPipelineRef = ref), o.mainPipeline ?? "success"),
    revertMerge: async () => ((w.revertOpened = true), { iid: 6, webUrl: "https://gitlab.test/merge_requests/6" }),
    closeWorkItem: async () => void (w.closed = true),
  };

  const jev: JevClient = {
    provider: "mock",
    async ask(_state, questions): Promise<JevAnswer[]> {
      w.jevAsked++;
      if (questions.some((q) => q.id === "injection")) {
        if (o.jev1 === "throw") throw new Error("Berget Jev call failed: HTTP 503");
        const t = o.jev1 ?? {};
        const p = t.injectionYes ?? 0.05;
        return [
          { id: "injection", value: p >= 0.5, probability: p, confidence: 0.9 },
          { id: "type", value: "feature", probability: 0.9, confidence: 0.9 },
          { id: "risk", value: t.risk ?? "low", probability: 0.9, confidence: 0.9 },
          { id: "clarity", value: t.clarity ?? 8, probability: 0.9, confidence: 0.9 },
          { id: "effort", value: 4, probability: 0.9, confidence: 0.9 },
        ];
      }
      if (o.jev2 === "throw") throw new Error("Berget Jev call failed: HTTP 503");
      return [
        { id: "diff_risk", value: 3, probability: 0.95, confidence: 0.95 },
        { id: "scope", value: true, probability: 0.95, confidence: 0.95 },
        { id: "sensitive", value: false, probability: 0.05, confidence: 0.95 },
      ];
    },
  };

  const repo: Repo = {
    clone: async () => {},
    diff: async () => ({ text: o.diffText ?? "diff --git a/src/List.tsx b/src/List.tsx\n+  if (loading) return <Spinner />;", numstat: o.numstat ?? "10\t2\tsrc/List.tsx\0" }),
    run: async (cmd) => (w.ran.push(cmd), { ok: o.gate !== "red", output: `ran ${cmd}` }),
    commitAndPush: async (_b, message) => ((w.commitMessage = message), "head5"),
    readFile: (path) =>
      path === ".factory.yml" ? (o.factoryFile ?? "install: pnpm install --frozen-lockfile\nlint: pnpm lint\ntest: pnpm test:unit\nbuild: pnpm build\n") : path === "run/test-changes.md" ? o.testChanges : undefined,
  };

  w.ctx = {
    gitlab: gitlab as GitLab,
    jev,
    teams: async (card: any) => void w.cards.push({ kind: KINDS[card.attachments[0].content.body[0].text.split(":")[0]], card }),
    agents: {
      claude: async (r) => {
        w.claudeCalls++;
        w.claudeRuns.push(r);
        const limit = ok("sess-limit", { isError: true, limitHit: true, resultText: "usage limit reached" });
        if (o.prepare === "limit" && !r.resumeSessionId) return limit;
        if (o.fixLimit && r.resumeSessionId) return limit;
        return ok("sess-1");
      },
      review: async () => (w.reviewsRun++, reviews.shift() ?? []),
    },
    record: newRecord(),
    target: loadTarget("react_frontend"),
    router: loadRouter(),
    dir: "/fake/run/target",
    repo,
    env: { payload: o.payload ?? payload, pipelineId: 1, pipelineUrl: "https://gitlab.test/pipelines/1" },
    startPipeline: async (vars) => void ((w.finishTriggered = true), (w.finishVars = vars)),
    restoreRun: async (id) => void w.restored.push(id),
    sleep: async () => {},
  };
  return w;
}

type World = ReturnType<typeof fakeWorld>;
const BUILD = [event, triage, preparePatch, codeReview, precommitGate, riskCheck, decision];
const FINISH = [apply, verify, resultSaved];

async function runSteps(w: World, steps: { run(ctx: StepContext): Promise<"next" | "stop"> }[]) {
  for (const s of steps) if ((await s.run(w.ctx)) === "stop") break;
  return w;
}
export const runBuildPipeline = (w: World) => runSteps(w, BUILD);
// The build pipeline as CI runs it: one runStep per job, with the record passed through dir.
export async function runBuildJobs(w: World, dir = mkdtempSync(join(tmpdir(), "jobs-"))) {
  const names = ["event", "triage", "prepare-patch", "code-review", "precommit-gate", "risk-check", "decision"];
  for (const [i, s] of BUILD.entries()) await runStep(names[i], s.run, { dir, make: () => w.ctx });
  return w;
}

// The scheduled jobs' view: counts and lists by label. Each waiting item's note points to pipeline 100 + iid,
// and starting a build from that pipeline "resumes" the session saved there.
export function fakeCtx(o: { ready?: number[]; waiting?: { iid: number; sessionId: string }[]; running: number; noteAuthor?: number; nonDeveloper?: number[] }) {
  const world = fakeWorld();
  const waiting = o.waiting ?? [];
  const g = world.ctx.gitlab;
  g.countLabeled = async (_p, label) => (label === "factory_running" ? o.running : label === "factory_waiting" ? waiting.length : 0);
  g.listLabeled = async (_p, label) =>
    (label === "factory_ready" ? (o.ready ?? []) : label === "factory_waiting" ? waiting.map((x) => x.iid) : []).map((iid) => ({ iid, labels: [label] }));
  // User 100 + iid added factory_ready. Items in nonDeveloper were labeled by a Reporter.
  g.labelAddedBy = async (_p, iid) => 100 + iid;
  g.memberAccessLevel = async (_p, user) => ((o.nonDeveloper ?? []).includes(user - 100) ? 20 : 30);
  g.notes = async (_p, iid) => [{ authorId: o.noteAuthor ?? BOT, body: `> *AI line*\n\n${waitingNote(100 + iid)}` }];
  const resumed: string[] = [];
  const started: Record<string, string>[] = [];
  const ctx = Object.assign(world.ctx, { resumed, started, world });
  ctx.startPipeline = async (vars) => {
    started.push(vars);
    const from = waiting.find((x) => 100 + x.iid === Number(vars.FACTORY_BUILD_PIPELINE_ID));
    if (from) resumed.push(from.sessionId);
  };
  return ctx;
}
// The finish pipeline gets the work item and MR from trigger variables, and starts with the build record.
export function runFinishPipeline(w: World, o: { decision?: "auto" | "needs_approval"; skipApply?: boolean; smoke?: string; workItemIid?: number; mrIid?: number } = {}) {
  w.ctx.env = { ...w.ctx.env, payload: undefined, workItemIid: o.workItemIid ?? 8, mrIid: o.mrIid ?? 5, skipApply: o.skipApply };
  w.stateLabels = ["factory_running"];
  let r = newRecord();
  r = { ...r, workItem: "acme/web/react_frontend#8" };
  for (const [step, d] of [
    ["event", { workItemIid: 8 }],
    ["prepare-patch", { sessionId: "sess-1", commands: { install: "i", lint: "l", test: "t", build: "b", ...(o.smoke ? { smoke: o.smoke } : {}) } }],
    ["precommit-gate", { passed: true, sha: "head5", mrIid: 5, mrUrl: "https://gitlab.test/merge_requests/5" }],
    ["risk-check", { headSha: "head5" }],
    ["decision", { kind: o.decision ?? "auto" }],
  ] as const) r = addStep(r, step, d);
  w.ctx.record = r;
  return runSteps(w, FINISH);
}
