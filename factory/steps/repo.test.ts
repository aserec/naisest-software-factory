import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { gitRepo, sandboxSettings } from "./repo";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("a hostile .git/config in the clone has no effect on the factory's git", async () => {
  const root = mkdtempSync(join(tmpdir(), "repo-test-"));
  // A server repo with one commit on master.
  const seed = join(root, "seed");
  git(root, "init", "-q", "-b", "master", seed);
  writeFileSync(join(seed, "a.txt"), "one\n");
  git(seed, "add", ".");
  git(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
  const server = join(root, "server.git");
  git(root, "clone", "-q", "--bare", seed, server);
  const evil = join(root, "evil.git");
  git(root, "init", "-q", "--bare", evil);
  const url = `file://${server}`;

  const dir = join(root, "run/target");
  const repo = gitRepo(dir, join(root, "run/target.git"), url, "tok", process.env);
  await repo.clone("master");

  // The agent writes a hostile config into its clone.
  const marker = join(root, "pwned");
  appendFileSync(join(dir, ".git/config"), [
    `[core]\n\tfsmonitor = "touch ${marker}-fsmonitor; false"`,
    `[url "file://${evil}"]\n\tinsteadOf = ${url}`,
    `[filter "x"]\n\tclean = "touch ${marker}-filter; cat"`,
    `[diff "x"]\n\ttextconv = "touch ${marker}-textconv; cat"`,
    `[diff]\n\texternal = "touch ${marker}-external"`,
  ].join("\n") + "\n");
  writeFileSync(join(dir, ".gitattributes"), "* filter=x diff=x\n");
  writeFileSync(join(dir, "a.txt"), "two\n");

  const d = await repo.diff();
  expect(d.text).toContain("+two");
  expect(d.numstat).toContain("a.txt");
  const sha = await repo.commitAndPush("factory/8-test", "change");

  expect(git(server, "rev-parse", "refs/heads/factory/8-test")).toBe(sha);
  expect(() => git(evil, "rev-parse", "refs/heads/factory/8-test")).toThrow();
  for (const k of ["fsmonitor", "filter", "textconv", "external"]) expect(existsSync(`${marker}-${k}`)).toBe(false);

  // A re-run force-pushes the same branch.
  writeFileSync(join(dir, "a.txt"), "three\n");
  const sha2 = await repo.commitAndPush("factory/8-test", "change again");
  expect(git(server, "rev-parse", "refs/heads/factory/8-test")).toBe(sha2);
});

test("gate sandbox: agent network allowlist, no /proc, writes only to the clone, HOME and /tmp", () => {
  const s = sandboxSettings("/w/run/target", "/tmp/h");
  expect(s.network.allowedDomains).toContain("registry.npmjs.org");
  // The factory checkout's .git may hold CI_JOB_TOKEN in its remote URL.
  // The runner keeps File-type variables in <project dir>.tmp; run/claude-home holds the agent's sessions.
  const root = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
  expect(s.filesystem.denyRead).toEqual(["/proc", `${root}/.git`, `${root}.tmp`, "/w/run/claude-home"]);
  expect(s.filesystem.allowWrite).toEqual(["/w/run/target", "/tmp/h", "/tmp"]);
});

test("readFile refuses links and paths that leave the clone", async () => {
  const root = mkdtempSync(join(tmpdir(), "repo-read-"));
  const dir = join(root, "target");
  mkdirSync(join(dir, "run"), { recursive: true });
  writeFileSync(join(root, "secret.txt"), "TOKEN");
  writeFileSync(join(dir, "run/test-changes.md"), "why");
  symlinkSync(join(root, "secret.txt"), join(dir, ".factory.yml"));
  symlinkSync(root, join(dir, "up"));
  const repo = gitRepo(dir, join(root, "target.git"), "file:///none", "tok", process.env);
  expect(repo.readFile("run/test-changes.md")).toBe("why");
  expect(repo.readFile("missing.md")).toBeUndefined();
  expect(() => repo.readFile(".factory.yml")).toThrow(/Refused/);
  expect(() => repo.readFile("up/secret.txt")).toThrow(/Refused/);
  expect(() => repo.readFile("../secret.txt")).toThrow(/Refused/);
});

test("only the root run/ dir is left out of the change; src/run/ is code", async () => {
  const root = mkdtempSync(join(tmpdir(), "repo-exclude-"));
  const seed = join(root, "seed");
  git(root, "init", "-q", "-b", "master", seed);
  writeFileSync(join(seed, "a.txt"), "one\n");
  git(seed, "add", ".");
  git(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
  const server = join(root, "server.git");
  git(root, "clone", "-q", "--bare", seed, server);
  const dir = join(root, "run/target");
  const repo = gitRepo(dir, join(root, "run/target.git"), `file://${server}`, "tok", process.env);
  await repo.clone("master");
  mkdirSync(join(dir, "run"));
  mkdirSync(join(dir, "src/run"), { recursive: true });
  writeFileSync(join(dir, "run/test-changes.md"), "why\n");
  writeFileSync(join(dir, "src/run/job.ts"), "export {};\n");
  const d = await repo.diff();
  expect(d.numstat).toContain("src/run/job.ts");
  expect(d.numstat).not.toContain("test-changes.md");
});
