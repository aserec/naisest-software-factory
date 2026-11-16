import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { makeFixSeams } from "../compose";
import { loadRouter, loadSeams, modelChoice } from "../config";
import { fakeCodeHost, fakeHarness } from "../fakes";
import { gitRepo } from "../repo";
import type { AgentPlan, HarnessJob, HarnessResult } from "../seams";
import { fix, fixPrompt, main } from "./fix";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const PLAN: AgentPlan = {
  id: "0123456789abcdef", path: "/runs", repo: "target", target: "react_frontend", summary: "Show the run cost in the list", steps: ["Add a cost column to the runs list", "Format it as dollars"],
  state: "running", user: "ana", at: "2026-11-08T10:00:00.000Z", approvedBy: "ben",
};

// A real server repo and clone; the code host, harness and dashboard are fakes.
function world(edit: (job: HarnessJob) => void, plan = PLAN, result: Partial<HarnessResult> = { text: "done" }) {
  const root = mkdtempSync(join(tmpdir(), "fix-test-"));
  const seed = join(root, "seed");
  git(root, "init", "-q", "-b", "master", seed);
  writeFileSync(join(seed, "README.md"), "hello\n");
  git(seed, "add", ".");
  git(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
  const server = join(root, "server.git");
  git(root, "clone", "-q", "--bare", seed, server);
  const dir = join(root, "run/target");
  const repo = gitRepo(dir, join(root, "run/target.git"), `file://${server}`, "tok", process.env);
  const pushed: string[] = [];
  const commit = repo.commitAndPush;
  repo.commitAndPush = async (branch, message) => (pushed.push(branch), commit(branch, message));
  const codeHost = fakeCodeHost({ baseBranch: "master", repo });
  const harness = fakeHarness((job) => (edit(job), result));
  const seams = loadSeams();
  return { codeHost, harness, pushed, run: () => fix({ plan, codeHost, repo, harness, model: modelChoice(loadRouter(undefined, seams).high.author, seams), dir }) };
}

test("an agent that edits a file opens one change on the plan's branch, and the body names the approver", async () => {
  const w = world((job) => writeFileSync(join(job.cwd, "cost.ts"), "export const cost = 1;\n"));
  const r = await w.run();
  expect(w.codeHost.changes.size).toBe(1);
  const c = [...w.codeHost.changes.values()][0];
  expect(c.branch).toBe("factory-fix/01234567");
  expect(c.title).toBe("fix: Show the run cost in the list");
  expect(c.body).toContain("1. Add a cost column to the runs list\n2. Format it as dollars");
  expect(c.body).toContain("Approved in the dashboard by ben");
  expect(r).toEqual({ url: c.url });
  expect(w.harness.jobs[0]).toMatchObject({ role: "author", tools: "code", maxTurns: 200 });
});

test("an agent that edits nothing fails the plan with its reason, masked before the cut, and opens no change", async () => {
  const w = world(() => {}, PLAN, { text: "The plan names no runs list. glpat-abcdefghijklmnopqrst" });
  expect(await w.run()).toEqual({ failed: "The agent made no changes: The plan names no runs list. [secret]" });
  expect(w.codeHost.changes.size).toBe(0);
  // A secret that crosses the 500 character cut is masked whole, not cut into a piece that no longer matches.
  const long = world(() => {}, PLAN, { text: `${"x".repeat(490)}glpat-abcdefghijklmnopqrst` });
  const r = await long.run();
  expect(r).toEqual({ failed: `The agent made no changes: ${"x".repeat(490)}[secret]` });
});

test("an agent that did not finish fails the plan with its text and pushes nothing, even with changes made", async () => {
  const edit = (job: HarnessJob) => writeFileSync(join(job.cwd, "cost.ts"), "export const cost = 1;\n");
  for (const result of [{ ok: false, text: "API error" }, { limitHit: true, text: "API error" }, { stopped: true, text: "API error" }]) {
    const w = world(edit, PLAN, result);
    expect(await w.run()).toEqual({ failed: "The agent did not finish: API error" });
    expect(w.pushed).toEqual([]);
    expect(w.codeHost.changes.size).toBe(0);
  }
});

test("a diff that holds a secret opens no change", async () => {
  const w = world((job) => writeFileSync(join(job.cwd, "token.ts"), `export const t = "glpat-abcdefghijklmnopqrst";\n`));
  expect(await w.run()).toEqual({ failed: "The fix held a secret, so nothing was pushed" });
  expect(w.codeHost.changes.size).toBe(0);
});

test("a plan step that holds a secret opens no change and pushes nothing", async () => {
  const w = world((job) => writeFileSync(join(job.cwd, "cost.ts"), "export const cost = 1;\n"), { ...PLAN, steps: ["Use the token glpat-abcdefghijklmnopqrst"] });
  expect(await w.run()).toEqual({ failed: "The fix held a secret, so nothing was pushed" });
  expect(w.codeHost.changes.size).toBe(0);
  expect(w.pushed).toEqual([]);
});

test("the agent's prompt holds the plan steps and nothing from the chat", async () => {
  const w = world(() => {});
  await w.run();
  const prompt = w.harness.jobs[0].prompt;
  expect(prompt).toBe(fixPrompt(PLAN));
  expect(prompt).toContain("<plan>");
  expect(prompt).toContain("2. Format it as dollars");
  expect(prompt).toContain("Do not commit or push.");
  // The plan holds no chat text, and nothing else of the plan but its summary and steps goes in.
  for (const field of [PLAN.user, PLAN.path, PLAN.approvedBy!]) expect(prompt).not.toContain(field);
});

test("main refuses a plan id that is not plain, as the id names the branch", async () => {
  await expect(main({ FACTORY_PLAN: JSON.stringify({ ...PLAN, id: "../bad" }) })).rejects.toThrow(/plan id/);
});

test("the factory repo's code host needs its token, read through the CI adapter", () => {
  const root = mkdtempSync(join(tmpdir(), "fix-seams-"));
  const secretDir = join(root, "secrets");
  mkdirSync(secretDir);
  const file = (name: string) => (writeFileSync(join(secretDir, name), `${name}-value-0123456789`), join(secretDir, name));
  const env = { FACTORY_PIPELINE: "fix", FACTORY_DASHBOARD_URL: "https://localhost:3000", FACTORY_DASHBOARD_TOKEN: file("dash") };
  expect(() => makeFixSeams(env, secretDir).factoryCodeHost()).toThrow("FACTORY_GITLAB_TOKEN is not set, so a factory plan cannot run");
  const s = makeFixSeams({ ...env, FACTORY_DASHBOARD_TOKEN: file("dash"), FACTORY_GITLAB_TOKEN: file("gl") }, secretDir);
  expect(typeof s.factoryCodeHost().openChange).toBe("function");
  expect(() => makeFixSeams({ FACTORY_PIPELINE: "fix", FACTORY_DASHBOARD_URL: "https://localhost:3000" }, secretDir)).toThrow("FACTORY_DASHBOARD_TOKEN is not set");
});

// main as the fix worker starts it: every secret a File type variable in the secret folder, and the dashboard's answers stubbed.
function mainWorld(plan: AgentPlan) {
  const secretDir = mkdtempSync(join(tmpdir(), "fix-main-"));
  const file = (name: string) => (writeFileSync(join(secretDir, name), `${name}-value-0123456789`), join(secretDir, name));
  const updates: { id: string; state: string; result?: string }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const m = /\/api\/factory\/plans\/([^/?]+)$/.exec(String(url));
    if (m && init?.method === "POST") updates.push({ id: decodeURIComponent(m[1]), ...JSON.parse(String(init.body)) });
    return new Response("{}", { status: 200 });
  });
  const env = {
    FACTORY_PIPELINE: "fix", FACTORY_TARGET: plan.target ?? "", FACTORY_DASHBOARD_URL: "https://localhost:3000", FACTORY_PLAN: JSON.stringify(plan),
    FACTORY_DASHBOARD_TOKEN: file("FACTORY_DASHBOARD_TOKEN"), FACTORY_GITLAB_TOKEN: file("FACTORY_GITLAB_TOKEN"), FACTORY_GITHUB_TOKEN: file("FACTORY_GITHUB_TOKEN"),
  };
  return { env, secretDir, updates };
}
afterEach(() => vi.unstubAllGlobals());

test("main runs a target plan in a clone of the target, reading each secret file only once, and ends the plan done", async () => {
  const plan: AgentPlan = { ...PLAN, target: "core_app" };
  const w = mainWorld(plan);
  const seen: Parameters<typeof fix>[0][] = [];
  await main(w.env, { secretDir: w.secretDir, fix: async (s) => (seen.push(s), { url: "https://example.test/pr/1" }) });
  expect(seen).toHaveLength(1);
  expect(seen[0].dir).toMatch(/run\/target$/);
  expect(w.updates).toEqual([{ id: plan.id, state: "done", result: "https://example.test/pr/1" }]);
});

test("main runs a factory plan in a clone of the factory repo and ends the plan done", async () => {
  const plan: AgentPlan = { ...PLAN, repo: "factory", target: undefined };
  const w = mainWorld(plan);
  const seen: Parameters<typeof fix>[0][] = [];
  await main(w.env, { secretDir: w.secretDir, fix: async (s) => (seen.push(s), { url: "https://example.test/mr/2" }) });
  expect(seen[0].dir).toMatch(/run\/factory$/);
  expect(w.updates).toEqual([{ id: plan.id, state: "done", result: "https://example.test/mr/2" }]);
});

test("a throw in the fix ends the plan as failed, with the secrets masked, and main still throws", async () => {
  const w = mainWorld(PLAN);
  const fail = async (): Promise<never> => {
    throw new Error("clone failed with glpat-abcdefghijklmnopqrst");
  };
  await expect(main(w.env, { secretDir: w.secretDir, fix: fail })).rejects.toThrow("clone failed");
  expect(w.updates).toHaveLength(1);
  expect(w.updates[0]).toMatchObject({ id: PLAN.id, state: "failed" });
  expect(w.updates[0].result).toContain("clone failed with [secret]");
});
