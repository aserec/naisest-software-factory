import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readTargets } from "./targets";

beforeEach(() => {
  vi.stubEnv("TARGETS_DIR", targetsDir("name: t1\nprojectPath: g/t1\n", "name: t2\nprojectPath: g/t2\n"));
});

function targetsDir(...files: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "targets-"));
  files.forEach((f, i) => writeFileSync(join(dir, `t${i + 1}.yml`), f));
  return dir;
}

describe("readTargets", () => {
  it("keeps a positive weekly budget and drops any other value", () => {
    const [a, b, c] = readTargets(targetsDir("name: a\nprojectPath: g/a\nweeklyBudgetUsd: 40\n", "name: b\nprojectPath: g/b\nweeklyBudgetUsd: -1\n", "name: c\nprojectPath: g/c\n"));
    expect([a.weeklyBudgetUsd, b.weeklyBudgetUsd, c.weeklyBudgetUsd]).toEqual([40, undefined, undefined]);
  });

  it("gives the default stuck minutes and lets the file override one", () => {
    const dir = targetsDir("name: a\nprojectPath: g/a\n", "name: b\nprojectPath: g/b\nstuckMinutes:\n  prepare-patch: 60\n");
    const [a, b] = readTargets(dir);
    expect(a).toMatchObject({ name: "a", projectPath: "g/a" });
    expect(a.stuckMinutes["prepare-patch"]).toBe(120);
    expect(b.stuckMinutes["prepare-patch"]).toBe(60);
    expect(b.stuckMinutes.triage).toBe(5);
  });

  it("names the tracker and code host, gitlab when the file has none, and wants githubRepo for a github tracker", () => {
    const [a, b] = readTargets(targetsDir("name: a\nprojectPath: g/a\n", "name: b\nprojectPath: o/b\ntracker: github-project\ncodeHost: github\ngithubRepo: o/b\ngithubProject: 3\n"));
    expect(a).toMatchObject({ tracker: "gitlab", codeHost: "gitlab" });
    expect(a.githubRepo).toBeUndefined();
    expect(b).toMatchObject({ tracker: "github-project", codeHost: "github", githubRepo: "o/b", githubProject: 3 });
    expect(() => readTargets(targetsDir("projectPath: o/c\ntracker: github\n"))).toThrow("githubRepo is missing");
  });

  it("refuses a tracker or code host it has no adapter for", () => {
    expect(() => readTargets(targetsDir("projectPath: o/c\ntracker: jira\n"))).toThrow("t1.yml: unknown tracker jira");
    expect(() => readTargets(targetsDir("projectPath: o/c\ncodeHost: bitbucket\n"))).toThrow("t1.yml: unknown codeHost bitbucket");
  });

  it("reads TARGETS_DIR when no dir is given", () => {
    expect(readTargets().map((t) => t.name)).toEqual(["t1", "t2"]);
  });
});
