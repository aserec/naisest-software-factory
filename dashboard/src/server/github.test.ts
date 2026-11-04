import { beforeEach, expect, it, vi } from "vitest";
import { makeGitHub } from "./github";
import type { TargetInfo } from "./targets";

beforeEach(() => vi.stubEnv("GITHUB_READ_TOKEN", "read-token"));

const target = (name: string, repo: string): TargetInfo => ({ name, projectPath: repo, stuckMinutes: {}, tracker: "github", codeHost: "github", githubRepo: repo });

it("canWrite is true for write or admin on any GitHub target's repo, and false for read, no answer or an error", async () => {
  const perms: Record<string, string | number> = { "o/a": "read", "o/b": "write" };
  const f = vi.fn(async (url: string) => {
    const repo = /repos\/(.+)\/collaborators/.exec(url)![1];
    const p = perms[repo];
    return typeof p === "number" ? new Response("no", { status: p }) : Response.json({ permission: p });
  }) as unknown as typeof fetch;
  const gh = makeGitHub(f);
  expect(await gh.canWrite("ann", [target("a", "o/a"), target("b", "o/b")])).toBe(true);
  perms["o/b"] = 404;
  expect(await gh.canWrite("ann", [target("a", "o/a"), target("b", "o/b")])).toBe(false);
  expect(await gh.canWrite("ann", [{ name: "gl", projectPath: "g/x", stuckMinutes: {}, tracker: "gitlab", codeHost: "gitlab" }])).toBe(false);
});
