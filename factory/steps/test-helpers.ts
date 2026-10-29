// Fake world for the step flow tests. Every outside tool is an in-memory fake that records what the steps did.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Finding } from "../agents";
import { loadRouter, loadSeams, loadTarget } from "../config";
import { FAKE_FACTORY, fakeChat, fakeCi, fakeCodeHost, fakeHarness, fakeJudge, fakeTracker } from "../fakes";
import { addStep, newRecord } from "../record";
import type { Checks, FactoryEvent, FactoryState, HarnessResult, JevAnswer, PersonRef, Repo } from "../seams";
import type { Risk } from "../types";
import { runStep, waitingNote, type StepContext } from "./context";
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

type Status = "success" | "failed" | "running" | "none";
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
  state?: FactoryState | null; // the ticket's live state; null for none
  otherRuns?: number; // other tickets in the running state
  payload?: unknown;
  actorLevel?: number; // below 30 the actor may not command the factory
  approvedBy?: PersonRef[];
  mrState?: "opened" | "merged";
  existingMr?: boolean;
  mrPipeline?: "success" | "failed";
  mainPipeline?: Status;
  defaultBranch?: string;
  title?: string; // the ticket title
}

export const BOT = FAKE_FACTORY;
export const mrEvent = (action: "approved" | "merge", actor: PersonRef = "dev"): FactoryEvent =>
  ({ kind: action === "merge" ? "merged" : "approved", ticket: "8", change: "5", actor });
const READY: FactoryEvent = { kind: "ready", ticket: "8", actor: "dev" };
const CHECKS: Record<Status, Checks> = { success: "green", failed: "red", running: "running", none: "none" };
const TRIAGE = ["injection", "type", "risk", "clarity", "effort"];

export function fakeWorld(o: WorldOptions = {}) {
  const reviews = [...(o.reviews ?? [[]])];
  const tracker = fakeTracker([
    { ref: "8", title: o.title ?? "Add a loading state", body: "Show a spinner while the list loads.", state: o.state === null ? undefined : (o.state ?? "ready") },
    { ref: "9", title: "Another ticket" },
    ...Array.from({ length: o.otherRuns ?? 0 }, (_, i) => ({ ref: String(20 + i), state: "running" as const })),
  ]);
  tracker.startedBy = async () => "dev";
  tracker.trusted = async (actor) => actor !== FAKE_FACTORY && (o.actorLevel ?? 30) >= 30;
  const ticket = tracker.tickets.get("8")!;
  const host = fakeCodeHost({
    defaultBranch: o.defaultBranch,
    head: "head5",
    landedSha: "manual789",
    existing: o.existingMr,
    merged: o.mrState === "merged",
    approvedByTrusted: (o.approvedBy ?? []).some((a) => a !== FAKE_FACTORY),
    changeChecks: CHECKS[o.mrPipeline ?? "success"],
    branchChecks: CHECKS[o.mainPipeline ?? "success"],
  });
  // Merging closes the ticket, as "Closes #8" does.
  const merge = host.merge;
  host.merge = async (ref, sha) => ((ticket.open = false), merge(ref, sha));
  const ci = fakeCi({ vars: { payload: o.payload ?? READY, run: "1", runUrl: "https://ci.example/runs/1" } });
  const chat = fakeChat();
  const judge = fakeJudge((q): JevAnswer => {
    if (TRIAGE.includes(q.id)) {
      if (o.jev1 === "throw") throw new Error("Berget Jev call failed: HTTP 503");
      const t = o.jev1 ?? {};
      const p = t.injectionYes ?? 0.05;
      const v: Record<string, JevAnswer["value"]> = { injection: p >= 0.5, type: "feature", risk: t.risk ?? "low", clarity: t.clarity ?? 8, effort: 4 };
      return { id: q.id, value: v[q.id], probability: q.id === "injection" ? p : 0.9, confidence: 0.9 };
    }
    if (o.jev2 === "throw") throw new Error("Berget Jev call failed: HTTP 503");
    const v: Record<string, JevAnswer["value"]> = { diff_risk: 3, scope: true, sensitive: false };
    return { id: q.id, value: v[q.id], probability: q.id === "sensitive" ? 0.05 : 0.95, confidence: 0.95 };
  });
  // The reviewer answers with the next review in the queue, as JSON text.
  const limit: Partial<HarnessResult> = { session: "sess-limit", ok: false, limitHit: true, text: "usage limit reached" };
  const harness = fakeHarness((job) => {
    if (job.role === "reviewer") return { text: JSON.stringify(reviews.shift() ?? []) };
    if (o.prepare === "limit" && !job.resume) return limit;
    if (o.fixLimit && job.resume) return limit;
    return { session: "sess-1", costUsd: 0.1, tokens: { input: 100, output: 20 }, text: "1. Which list?" };
  });
  const ran: string[] = [];
  let commitMessage = "";
  const repo: Repo = {
    clone: async () => {},
    diff: async () => ({ text: o.diffText ?? "diff --git a/src/List.tsx b/src/List.tsx\n+  if (loading) return <Spinner />;", numstat: o.numstat ?? "10\t2\tsrc/List.tsx\0" }),
    run: async (cmd) => (ran.push(cmd), { ok: o.gate !== "red", output: `ran ${cmd}` }),
    commitAndPush: async (_b, message) => ((commitMessage = message), "head5"),
    readFile: (path) =>
      path === ".factory.yml" ? (o.factoryFile ?? "install: pnpm install --frozen-lockfile\nlint: pnpm lint\ntest: pnpm test:unit\nbuild: pnpm build\n") : path === "run/test-changes.md" ? o.testChanges : undefined,
  };
  const seams = loadSeams();
  const ctx: StepContext = {
    tracker, codeHost: host, ci, judge, chat,
    harnesses: { "claude-code": harness, pi: harness },
    seams,
    record: newRecord(),
    target: loadTarget("react_frontend", { defaultApprover: "approver" }),
    router: loadRouter(undefined, seams),
    dir: "/fake/run/target",
    repo,
    sleep: async () => {},
  };

  const w = {
    tracker, host, ci, chat, judge, harness, ran, ctx,
    // A change of ticket 8 that waits for a person, opened by an earlier build run.
    openChange: (body = "Factory run 41: https://ci.example/runs/41") => void host.openChange("factory/8-add-a-loading-state", "Add a loading state", body, "8"),
    get states() { return ticket.state ? [ticket.state] : []; },
    get workItemComments() { return tracker.posted.map((p) => p.text); },
    get mrComments() { return host.mrComments; },
    get mrDescription() { return host.mrDescription; },
    get mrTitle() { return host.mrTitle; },
    get mrOpened() { return host.mrOpened; },
    get merged() { return host.merged; },
    get mergedSha() { return host.mergedSha; },
    get revertOpened() { return host.revertOpened; },
    get mainPipelineRef() { return host.mainPipelineRef; },
    get commitMessage() { return commitMessage; },
    get cards() { return chat.sent; },
    get assigned() { return ticket.assignees.length > 0 || host.assigned.length > 0; },
    get closed() { return !ticket.open; },
    get finishTriggered() { return ci.finishTriggered; },
    get finishVars() { return ci.finishVars; },
    get restored() { return ci.restored; },
    get claudeRuns() { return harness.jobs.filter((j) => j.role !== "reviewer"); },
    get claudeCalls() { return this.claudeRuns.length; },
    get reviewsRun() { return harness.jobs.filter((j) => j.role === "reviewer").length; },
    get jevAsked() { return judge.asked; },
    get record() { return this.ctx.record; },
  };
  const p = o.payload as FactoryEvent | undefined;
  if (p?.kind === "approved" || p?.kind === "merged") w.openChange();
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

// The scheduled jobs' view: tickets by state. Each waiting ticket's comment points to run 100 + ticket,
// and starting a build from that run "resumes" the session saved there.
export function fakeCtx(o: { ready?: number[]; waiting?: { iid: number; sessionId: string }[]; running: number; noteAuthor?: PersonRef; nonDeveloper?: number[] }) {
  const world = fakeWorld({ state: null });
  const waiting = o.waiting ?? [];
  const t = world.tracker;
  const add = (ref: string, state: FactoryState) => t.tickets.set(ref, { ...t.tickets.get("9")!, ref, state });
  for (const ref of o.ready ?? []) add(String(ref), "ready");
  for (const { iid } of waiting) add(String(iid), "waiting");
  for (let i = 0; i < o.running; i++) add(`r${i}`, "running");
  // Person user-<ticket> set the ticket ready. Tickets in nonDeveloper were set ready by a Reporter.
  t.startedBy = async (ref) => `user-${ref}`;
  t.trusted = async (actor) => !(o.nonDeveloper ?? []).some((n) => actor === `user-${n}`);
  t.comments = async (ref) => [{ author: o.noteAuthor ?? FAKE_FACTORY, byFactory: !o.noteAuthor, body: waitingNote(String(100 + Number(ref))), at: "2026-10-29T00:00:00Z" }];
  const resumed: string[] = [];
  const start = world.ci.start;
  world.ci.start = async (run) => {
    await start(run);
    const from = waiting.find((x) => String(100 + x.iid) === run.buildRun);
    if (from) resumed.push(from.sessionId);
  };
  return Object.assign(world.ctx, { resumed, world });
}

// The finish run gets the ticket and change from its variables, and starts with the build record.
export function runFinishPipeline(w: World, o: { decision?: "auto" | "needs_approval"; skipApply?: boolean; smoke?: string; workItemIid?: string; mrIid?: string } = {}) {
  w.ci.vars = { ...w.ci.vars, payload: undefined, ticket: o.workItemIid ?? "8", change: o.mrIid ?? "5", skipApply: !!o.skipApply };
  w.tracker.tickets.get("8")!.state = "running";
  w.openChange();
  let r = newRecord();
  r = { ...r, workItem: "acme/web/react_frontend#8" };
  for (const [step, d] of [
    ["event", { ticket: "8" }],
    ["prepare-patch", { sessionId: "sess-1", commands: { install: "i", lint: "l", test: "t", build: "b", ...(o.smoke ? { smoke: o.smoke } : {}) } }],
    ["precommit-gate", { passed: true, sha: "head5", change: "5", changeUrl: "https://host.example/changes/5" }],
    ["risk-check", { headSha: "head5" }],
    ["decision", { kind: o.decision ?? "auto" }],
  ] as const) r = addStep(r, step, d);
  w.ctx.record = r;
  return runSteps(w, FINISH);
}
