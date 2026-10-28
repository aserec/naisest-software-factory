import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  expect(s.filesystem.denyRead).toEqual(["/proc"]);
  expect(s.filesystem.allowWrite).toEqual(["/w/run/target", "/tmp/h", "/tmp"]);
});
