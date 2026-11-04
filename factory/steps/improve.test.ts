import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadRouter, loadSeams, loadTarget } from "../config";
import { fakeCi, fakeCodeHost, fakeDashboard, fakeHarness, fakeJudge, fakeTracker } from "../fakes";
import { gitRepo } from "../repo";
import { newRecord } from "../record";
import { SWITCHES } from "../run-events";
import type { Checks, JevAnswer, RunEvent } from "../seams";
import type { StepContext } from "./context";
import { improve, improveBranch, main } from "./improve";

const NOW = new Date("2026-11-04T12:00:00Z");
const DAY = "2026-11-04";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const REVIEW = "Check the diff.\n";
const AUTHOR = "Run `scripts/old.sh` first.\n";
const LINKS = [5, 6, 7].map((n) => `https://host.example/changes/${n}`);
const proposal = (...edits: object[]) => JSON.stringify({ edits });
const reviewChange = { path: ".factory/review.md", kind: "change", text: `${REVIEW}Explain every protected path.\n`, why: "People merge these changes without edits.", evidence: LINKS };
const authorFix = { path: ".factory/author.md", kind: "fix", text: "Run `scripts/new.sh` first.\n", gone: "scripts/old.sh", why: "The script moved.", evidence: [] };

interface Options { reply?: string; evidence?: boolean; checks?: Checks; moved?: boolean; mergeThrows?: boolean; switchOff?: boolean; writerOk?: boolean }

// A real server repo and clone; the code host, tracker, dashboard and writer are fakes.
async function world(o: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "improve-test-"));
  const seed = join(root, "seed");
  git(root, "init", "-q", "-b", "master", seed);
  mkdirSync(join(seed, ".factory"));
  mkdirSync(join(seed, "scripts"));
  writeFileSync(join(seed, ".factory/review.md"), REVIEW);
  writeFileSync(join(seed, ".factory/author.md"), AUTHOR);
  writeFileSync(join(seed, "scripts/new.sh"), "echo new\n");
  writeFileSync(join(seed, "package.json"), "{}\n");
  git(seed, "add", ".");
  git(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
  const server = join(root, "server.git");
  git(root, "clone", "-q", "--bare", seed, server);

  const dir = join(root, "run/target");
  const repo = gitRepo(dir, join(root, "run/target.git"), `file://${server}`, "tok", process.env);
  const pushed: string[] = [];
  const commit = repo.commitAndPush;
  repo.commitAndPush = async (branch, message) => (pushed.push(await commit(branch, message)), pushed.at(-1)!);

  const host = fakeCodeHost({ baseBranch: "master", changeChecks: o.checks ?? "green", repo });
  const tracker = fakeTracker([8, 9, 10].map((n) => ({ ref: String(n), title: `Ticket ${n}` })));
  const dashboard = fakeDashboard(o.switchOff ? { switches: Object.fromEntries(SWITCHES.map((n) => [n, n !== "improve"])) as never } : {});
  // Three tickets whose needs_approval decision a person overruled: they merged the change as it was (changes 5, 6 and 7).
  if (o.evidence !== false) {
    for (const n of [8, 9, 10]) {
      await host.openChange(`factory/${n}-work`, `Work ${n}`, "x", String(n));
      host.mergeByPerson(String(n - 3));
      host.commits.set(String(n - 3), [{ sha: "a", byFactory: true }]);
      dashboard.events.push({ id: `d${n}`, run: `r${n}`, at: "2026-11-01T12:00:00.000Z", target: "react_frontend", ticket: String(n), type: "decision", data: { auto: false, reasons: ["protected path touched"] } });
    }
  }
  // The fake host knows one head. The change the factory opens has the commit the factory just pushed.
  const open = host.openChange;
  host.openChange = async (...a) => {
    const r = await open(...a);
    if (a[0].startsWith("factory-improve/")) host.changes.get(r.ref)!.head = o.moved ? "someone-pushed" : pushed.at(-1)!;
    return r;
  };
  if (o.moved) host.checks = async () => "green";
  if (o.mergeThrows) host.merge = async () => { throw new Error("merge refused"); };

  const judge = fakeJudge((q): JevAnswer => ({ id: q.id, value: false, probability: 0.05, confidence: 0.9 }));
  const harness = fakeHarness(() => ({ text: o.reply ?? proposal(), ok: o.writerOk ?? true }));
  const seams = loadSeams();
  const ctx: StepContext = {
    tracker, codeHost: host, ci: fakeCi(), judge, chat: undefined as never, dashboard,
    harnesses: { "claude-code": harness, pi: harness }, seams, record: newRecord(),
    target: loadTarget("react_frontend", { defaultApprover: "approver" }), router: loadRouter(undefined, seams), dir, repo, sleep: async () => {},
  };

  return { server, ctx, host, dashboard, harness, pushed };
}
type World = Awaited<ReturnType<typeof world>>;

const branches = (w: World) => git(w.server, "branch", "--list", "factory-improve/*");
const opened = (w: World) => [...w.host.changes.values()].filter((c) => c.title !== "" && (c as { branch: string }).branch.startsWith("factory-improve/"));
const files = (w: World, branch: string) => git(w.server, "diff", "--name-only", "master", branch).split("\n");
const show = (w: World, branch: string, path: string) => git(w.server, "show", `${branch}:${path}`);

async function run(o: Options = {}) {
  const w = await world(o);
  return { w, out: await improve(w.ctx, NOW) };
}

test("the switch off: no writer call, nothing pushed", async () => {
  const { w, out } = await run({ switchOff: true, reply: proposal(reviewChange) });
  expect(out).toEqual({});
  expect(w.harness.jobs).toHaveLength(0);
  expect(branches(w)).toBe("");
});

test("no evidence: no writer call and no change", async () => {
  const { w, out } = await run({ evidence: false, reply: proposal(reviewChange) });
  expect(out).toEqual({});
  expect(w.harness.jobs).toHaveLength(0);
  expect(branches(w)).toBe("");
});

test("a proposed change opens one change for the approver, with the 3 links, no closing line, and only the one file", async () => {
  const { w, out } = await run({ reply: proposal(reviewChange) });
  const branch = improveBranch("change", DAY);
  expect(branch).toBe("factory-improve/change-2026-11-04");
  expect(out).toEqual({ change: "8" });
  const job = w.harness.jobs[0];
  expect([job.role, job.tools, job.maxTurns]).toEqual(["writer", "none", 1]);
  expect(w.host.mrTitle).toBe(`chore(factory): weekly instruction changes ${DAY}`);
  expect(w.host.mrDescription).toContain("## .factory/review.md");
  expect(w.host.mrDescription).toContain("People merge these changes without edits.");
  for (const l of LINKS) expect(w.host.mrDescription).toContain(`- ${l}`);
  expect(w.host.mrDescription).not.toContain("Closes #");
  expect(w.host.assigned).toEqual([{ ref: "8", person: "approver" }]);
  expect(files(w, branch)).toEqual([".factory/review.md"]);
  expect(show(w, branch, ".factory/review.md")).toContain("Explain every protected path.");
  expect(w.host.merged).toBe(false);
});

test("a confirmed fix with green checks merges with its pushed sha; with no changes, no change is opened", async () => {
  const { w, out } = await run({ reply: proposal(authorFix) });
  expect(out).toEqual({ fix: "8", fixMerged: true });
  expect(w.host.merged).toBe(true);
  expect(w.host.mergedSha).toBe(w.pushed[0]);
  expect(w.host.mrTitle).toBe("fix(factory): drop instructions for paths that no longer exist");
  expect(w.host.mrDescription).toContain("`.factory/author.md`: `scripts/old.sh` no longer exists in the repo.");
  expect(show(w, improveBranch("fix", DAY), ".factory/author.md")).toBe("Run `scripts/new.sh` first.");
  expect(branches(w)).not.toContain("change-");
  expect(w.host.assigned).toEqual([]);
});

test("a fix with red checks is not merged: it is commented and assigned to the approver", async () => {
  const { w, out } = await run({ reply: proposal(authorFix), checks: "red" });
  expect(out).toEqual({ fix: "8", fixMerged: false });
  expect(w.host.merged).toBe(false);
  expect(w.host.mrComments).toEqual(["The pipeline is red, so the factory did not merge this fix."]);
  expect(w.host.assigned).toEqual([{ ref: "8", person: "approver" }]);
});

test("a fix whose head moved is not merged", async () => {
  const { w, out } = await run({ reply: proposal(authorFix), moved: true });
  expect(out.fixMerged).toBe(false);
  expect(w.host.merged).toBe(false);
  expect(w.host.mrComments).toEqual(["The change moved since the factory pushed it, so the factory did not merge this fix."]);
  expect(w.host.assigned).toEqual([{ ref: "8", person: "approver" }]);
});

test("a merge that throws is commented and assigned, and the job goes on", async () => {
  const { w, out } = await run({ reply: proposal(authorFix), mergeThrows: true });
  expect(out).toEqual({ fix: "8", fixMerged: false });
  expect(w.host.mrComments[0]).toContain("merge refused");
  expect(w.host.assigned).toEqual([{ ref: "8", person: "approver" }]);
});

test("a fix that also adds a sentence goes into the change, says so, and no fix is opened", async () => {
  const text = "Run `scripts/new.sh` first.\nThen run the tests.\n";
  const { w, out } = await run({ reply: proposal({ ...authorFix, text, evidence: LINKS }) });
  expect(out).toEqual({ change: "8" });
  expect(w.host.mrDescription).toContain("Proposed as a fix, but the factory could not confirm that scripts/old.sh is gone.");
  expect(branches(w)).not.toContain("fix-");
  expect(w.host.merged).toBe(false);
});

test("a fix and a change together: the change branch holds the change and not the fix", async () => {
  const { w, out } = await run({ reply: proposal(authorFix, reviewChange) });
  expect(out).toEqual({ fix: "8", change: "9", fixMerged: true });
  expect(files(w, improveBranch("fix", DAY))).toEqual([".factory/author.md"]);
  expect(files(w, improveBranch("change", DAY))).toEqual([".factory/review.md"]);
  expect(w.host.assigned).toEqual([{ ref: "9", person: "approver" }]);
});

test("the writer answers no edits: nothing is opened", async () => {
  const { w, out } = await run({ reply: proposal() });
  expect(out).toEqual({});
  expect(branches(w)).toBe("");
});

test("a change that cites too little evidence is dropped, and nothing is opened", async () => {
  const { w, out } = await run({ reply: proposal({ ...reviewChange, evidence: LINKS.slice(0, 2) }) });
  expect(out).toEqual({});
  expect(branches(w)).toBe("");
});

test("a writer run that fails throws", async () => {
  const w = await world({ writerOk: false });
  await expect(improve(w.ctx, NOW)).rejects.toThrow("writer run failed");
  expect(branches(w)).toBe("");
});

test("the dashboard is down: improve rejects, nothing is pushed and no change is opened", async () => {
  const w = await world({ reply: proposal(reviewChange) });
  w.dashboard.down = true;
  await expect(improve(w.ctx, NOW)).rejects.toThrow("dashboard is down");
  expect(w.harness.jobs).toHaveLength(0);
  expect(branches(w)).toBe("");
  expect(opened(w)).toHaveLength(0);
});

test("a secret in the changed file stops the job before the push", async () => {
  const w = await world({ reply: proposal({ ...reviewChange, text: `${REVIEW}token glpat-${"a".repeat(24)}\n` }) });
  await expect(improve(w.ctx, NOW)).rejects.toThrow("secret");
  expect(branches(w)).toBe("");
});

test("a secret in the change text stops the job before the push", async () => {
  const w = await world({ reply: proposal({ ...reviewChange, why: `see sk-ant-${"b".repeat(20)}` }) });
  await expect(improve(w.ctx, NOW)).rejects.toThrow("secret");
  expect(branches(w)).toBe("");
});

test("a changed path outside the four files stops the job before the push", async () => {
  const w = await world({ reply: proposal(reviewChange) });
  const diff = w.ctx.repo.diff;
  w.ctx.repo.diff = async () => ({ ...(await diff()), numstat: "1\t0\tsrc/app.ts\0" });
  await expect(improve(w.ctx, NOW)).rejects.toThrow("src/app.ts");
  expect(branches(w)).toBe("");
});

test("main needs FACTORY_SCHEDULE=improve", async () => {
  await expect(main({})).rejects.toThrow("FACTORY_SCHEDULE must be improve");
  await expect(main({ FACTORY_SCHEDULE: "watch" })).rejects.toThrow("FACTORY_SCHEDULE must be improve");
});
