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

// The branch moves on the server right after the clone. Our git dir must still hold the clone's commit.
test("the clone and the factory's git dir start from the same commit when the branch moves in between", async () => {
  const root = mkdtempSync(join(tmpdir(), "repo-race-"));
  const seed = join(root, "seed");
  git(root, "init", "-q", "-b", "master", seed);
  writeFileSync(join(seed, "a.txt"), "one\n");
  git(seed, "add", ".");
  git(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
  const server = join(root, "server.git");
  git(root, "clone", "-q", "--bare", seed, server);
  // A git on PATH that pushes a new commit to the server after the first clone.
  const bin = join(root, "bin");
  mkdirSync(bin);
  const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\n"${real}" "$@" || exit $?\ncase "$*" in *" clone "*) [ -e "${root}/moved" ] || { touch "${root}/moved"; cd "${seed}" && "${real}" -c user.name=t -c user.email=t@t commit -q --allow-empty -m next && "${real}" push -q "${server}" master; } ;; esac\n`, { mode: 0o755 });
  const dir = join(root, "run/target");
  const gitDir = join(root, "run/target.git");
  await gitRepo(dir, gitDir, `file://${server}`, "tok", { ...process.env, PATH: `${bin}:${process.env.PATH}` }).clone("master");
  expect(existsSync(join(root, "moved"))).toBe(true);
  expect(git(root, "--git-dir", gitDir, "rev-parse", "HEAD")).toBe(git(dir, "rev-parse", "HEAD"));
});

// An agent-written `* -diff` must not turn the change into "Binary files differ" for the review, secret scan and size rule.
test("a -diff attribute in the clone does not hide the changed lines", async () => {
  const root = mkdtempSync(join(tmpdir(), "repo-test-"));
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
  writeFileSync(join(dir, ".gitattributes"), "* -diff\n");
  writeFileSync(join(dir, "a.txt"), "glpat-secret\n");
  const d = await repo.diff();
  expect(d.text).toContain("+glpat-secret");
  // numstat still counts the file as binary, 0 lines. The protected-path rule on .gitattributes closes that gap for the size rule.
  expect(d.numstat).toContain(".gitattributes");
});

// Our git dir is a bare clone, which has no index. Built by `add -A` alone, the index would leave out tracked files
// under an ignored path, and the diff and the pushed commit would delete them.
test("tracked files under an ignored path and a submodule are not part of the change", async () => {
  const root = mkdtempSync(join(tmpdir(), "repo-test-"));
  const seed = join(root, "seed");
  git(root, "init", "-q", "-b", "master", seed);
  writeFileSync(join(seed, "a.txt"), "one\n");
  writeFileSync(join(seed, ".gitignore"), "notes/\n");
  mkdirSync(join(seed, "notes"));
  writeFileSync(join(seed, "notes/kept.md"), "tracked anyway\n");
  git(seed, "add", ".");
  git(seed, "add", "-f", "notes/kept.md");
  git(seed, "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},sub`);
  git(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
  const server = join(root, "server.git");
  git(root, "clone", "-q", "--bare", seed, server);

  const dir = join(root, "run/target");
  const repo = gitRepo(dir, join(root, "run/target.git"), `file://${server}`, "tok", process.env);
  await repo.clone("master");
  writeFileSync(join(dir, "a.txt"), "two\n");

  expect((await repo.diff()).numstat.split("\0").filter(Boolean)).toEqual(["1\t1\ta.txt"]);
  await repo.commitAndPush("factory/8-test", "change");
  expect(git(server, "ls-tree", "-r", "--name-only", "factory/8-test").split("\n")).toEqual([".gitignore", "a.txt", "notes/kept.md", "sub"]);
});

test("gate sandbox: agent network allowlist, no /proc, writes only to the clone, HOME and /tmp", () => {
  const s = sandboxSettings("/w/run/target", "/tmp/h");
  expect(s.network.allowedDomains).toContain("registry.npmjs.org");
  // The factory checkout's .git may hold CI_JOB_TOKEN in its remote URL.
  // The runner keeps File-type variables in <project dir>.tmp; run/claude-home and run/pi-home hold the agent sessions.
  const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  expect(s.filesystem.denyRead).toEqual(["/proc", `${root}/.git`, `${root}.tmp`, "/w/run/claude-home", "/w/run/pi-home"]);
  expect(s.filesystem.allowWrite).toEqual(["/w/run/target", "/tmp/h", "/tmp"]);
  expect(s.network).not.toHaveProperty("allowLocalBinding");
  // A local run: the pnpm store, the real /tmp on macOS, and local ports.
  const local = sandboxSettings("/w/run/target", "/tmp/h", "/c/store");
  expect(local.filesystem.allowWrite).toEqual(["/w/run/target", "/tmp/h", "/tmp", "/c/store", "/private/tmp"]);
  expect(local.network).toMatchObject({ allowLocalBinding: true });
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

// Review Focus 1: the model gets only plain files from inside the clone, and small ones.
test("readBytes returns plain small files and undefined for everything else", () => {
  const root = mkdtempSync(join(tmpdir(), "repo-bytes-"));
  const dir = join(root, "target");
  mkdirSync(join(dir, "run/proof"), { recursive: true });
  writeFileSync(join(root, "outside.png"), "PNGDATA12");
  symlinkSync(join(root, "outside.png"), join(dir, "run/proof/after-a.png"));
  writeFileSync(join(dir, "run/proof/plain.png"), "123456789");
  const repo = gitRepo(dir, join(root, "target.git"), "file:///none", "tok", process.env);
  const MAX = 1000;
  expect(repo.readBytes("run/proof/after-a.png", MAX)).toBeUndefined();
  expect(repo.readBytes("../outside.png", MAX)).toBeUndefined();
  expect(repo.readBytes("run/proof/plain.png", MAX)).toEqual(Buffer.from("123456789"));
  expect(repo.readBytes("run/proof/plain.png", 4)).toBeUndefined();
  expect(repo.readBytes("run/proof/missing.png", MAX)).toBeUndefined();
});
