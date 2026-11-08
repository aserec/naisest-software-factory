import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadRouter, loadSeams, modelChoice } from "../config";
import { fakeCodeHost, fakeDashboard, fakeHarness } from "../fakes";
import { gitRepo } from "../repo";
import type { AgentPlan, HarnessJob } from "../seams";
import { fix, fixPrompt, main } from "./fix";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const PLAN: AgentPlan = {
  id: "0123456789abcdef", path: "/runs", repo: "target", target: "react_frontend", summary: "Show the run cost in the list", steps: ["Add a cost column to the runs list", "Format it as dollars"],
  state: "running", user: "ana", at: "2026-11-08T10:00:00.000Z", approvedBy: "ben",
};

// A real server repo and clone; the code host, harness and dashboard are fakes.
function world(edit: (job: HarnessJob) => void) {
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
  const codeHost = fakeCodeHost({ baseBranch: "master", repo });
  const harness = fakeHarness((job) => (edit(job), { text: "done" }));
  const seams = loadSeams();
  return { codeHost, harness, run: () => fix({ plan: PLAN, codeHost, repo, harness, model: modelChoice(loadRouter(undefined, seams).high.author, seams), dashboard: fakeDashboard(), dir }) };
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

test("an agent that edits nothing fails the plan and opens no change", async () => {
  const w = world(() => {});
  expect(await w.run()).toEqual({ failed: "The agent made no changes" });
  expect(w.codeHost.changes.size).toBe(0);
});

test("a diff that holds a secret opens no change", async () => {
  const w = world((job) => writeFileSync(join(job.cwd, "token.ts"), `export const t = "glpat-abcdefghijklmnopqrst";\n`));
  expect(await w.run()).toEqual({ failed: "The fix held a secret, so nothing was pushed" });
  expect(w.codeHost.changes.size).toBe(0);
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
