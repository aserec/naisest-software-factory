// Fake world for the step flow tests. Every outside call is an in-memory fake that records what the steps did.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ClaudeResult, Finding } from "../agents";
import { loadRouter, loadTarget } from "../config";
import { STATE_LABELS, type GitLab } from "../gitlab";
import type { JevAnswer, JevClient } from "../jev";
import { addStep } from "../record";
import type { Risk } from "../types";
import { newRecord, type Repo, type StepContext } from "./context";
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
  numstat?: string;
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
const ok = (sessionId: string, extra: Partial<ClaudeResult> = {}): ClaudeResult => ({ sessionId, isError: false, limitHit: false, costUsd: 0.1, resultText: "1. Which list?", ...extra });

export function fakeWorld(o: WorldOptions = {}) {
  const reviews = [...(o.reviews ?? [[]])];
  const w = {
    stateLabels: [...(o.liveLabels ?? ["factory_ready"])],
    workItemComments: [] as string[],
    mrComments: [] as string[],
    mrDescription: "",
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
    getWorkItem: async () => ({ title: "Add a loading state", description: "Show a spinner while the list loads.", labels: [...w.stateLabels], assigneeIds: [], webUrl: "https://gitlab.test/work_items/8", state: w.closed ? "closed" : "opened" }),
    reopenWorkItem: async () => void (w.closed = false),
    botUserId: async () => BOT,
    memberAccessLevel: async () => o.actorLevel ?? 30,
    countLabeled: async () => 0,
    setState: async (_p, _i, label) => void (w.stateLabels = [...w.stateLabels.filter((l) => !(STATE_LABELS as readonly string[]).includes(l)), label]),
    comment: async (_p, _i, body) => void w.workItemComments.push(body),
    commentMergeRequest: async (_p, _i, body) => void w.mrComments.push(body),
    userId: async () => 99,
    assignWorkItem: async () => void (w.assigned = true),
    assignMergeRequest: async () => void (w.assigned = true),
    upsertMergeRequest: async (_p, _b, _t, _title, description) => ((w.mrDescription = description), (w.mrOpened = !o.existingMr), { iid: 5, webUrl: "https://gitlab.test/merge_requests/5" }),
    getMergeRequest: async () => ({ state: o.mrState ?? "opened", description: "Factory run: https://gitlab.test/pipelines/41", headSha: "head5", mergeSha: "manual789" }),
    approvedBy: async () => o.approvedBy ?? [],
    mergeRequestPipelineStatus: async () => o.mrPipeline ?? "success",
    // Merging closes the work item, as "Closes #8" does in GitLab.
    merge: async (_p, _i, sha) => ((w.merged = true), (w.mergedSha = sha), (w.closed = true), "abc123def456"),
    pipelineStatus: async (_p, ref) => ((w.mainPipelineRef = ref), o.mainPipeline ?? "success"),
    revertMerge: async () => ((w.revertOpened = true), { iid: 6, webUrl: "https://gitlab.test/merge_requests/6" }),
    closeWorkItem: async () => void (w.closed = true),
  };

  const jev: JevClient = {
    provider: "mock",
    async ask(_state, questions): Promise<JevAnswer[]> {
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
    diff: async () => ({ text: "diff --git a/src/List.tsx b/src/List.tsx\n+  if (loading) return <Spinner />;", numstat: o.numstat ?? "10\t2\tsrc/List.tsx\0" }),
    run: async (cmd) => ({ ok: o.gate !== "red", output: `ran ${cmd}` }),
    commitAndPush: async () => "head5",
    readFile: (path) =>
      path === ".factory.yml" ? "install: pnpm install --frozen-lockfile\nlint: pnpm lint\ntest: pnpm test:unit\nbuild: pnpm build\n" : path === "run/test-changes.md" ? o.testChanges : undefined,
  };

  w.ctx = {
    gitlab: gitlab as GitLab,
    jev,
    teams: async (card: any) => void w.cards.push({ kind: KINDS[card.attachments[0].content.body[0].text.split(":")[0]], card }),
    agents: {
      claude: async (r) => {
        w.claudeCalls++;
        if (o.prepare === "limit" && !r.resumeSessionId) return ok("sess-1", { isError: true, limitHit: true, resultText: "usage limit reached" });
        return ok("sess-1");
      },
      review: async () => reviews.shift() ?? [],
    },
    record: newRecord(),
    target: loadTarget("react_frontend"),
    router: loadRouter(),
    dir: "/fake/run/target",
    repo,
    env: { payload: o.payload ?? payload, pipelineId: 1, pipelineUrl: "https://gitlab.test/pipelines/1" },
    startFinish: async (vars) => void ((w.finishTriggered = true), (w.finishVars = vars)),
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
// The finish pipeline gets the work item and MR from trigger variables, and starts with the build record.
export function runFinishPipeline(w: World, o: { decision?: "auto" | "needs_approval"; skipApply?: boolean; smoke?: string } = {}) {
  w.ctx.env = { ...w.ctx.env, payload: undefined, workItemIid: 8, mrIid: 5, skipApply: o.skipApply };
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
