import { beforeEach, expect, it, vi } from "vitest";
import { makeGitHub } from "./github";
import type { TargetInfo } from "./targets";

beforeEach(() => vi.stubEnv("GITHUB_READ_TOKEN", "read-token"));

const target = (name: string, repo: string, project?: number): TargetInfo => ({ name, projectPath: repo, stuckMinutes: {}, github: { repo, project } });
const card = (repo: string, number: number, status: string | null, state = "OPEN") => ({
  updatedAt: "2026-11-03T10:00:00Z", fieldValueByName: status ? { name: status } : null,
  content: { number, title: `T${number}`, url: `https://github.com/${repo}/issues/${number}`, state, repository: { nameWithOwner: repo } },
});

it("board reads a shared GitHub board once and gives each target its open cards in factory columns", async () => {
  let reads = 0;
  const f = vi.fn(async (_url: string, init: RequestInit) => {
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer read-token");
    reads++;
    return Response.json({ data: { repositoryOwner: { projectV2: { items: { pageInfo: { hasNextPage: false }, nodes: [
      card("o/web", 1, "Ready"), card("o/web", 2, "Needs approval"), card("o/web", 3, "Backlog"), card("o/web", 4, "Ready", "CLOSED"),
      card("o/api", 5, "Running"), card("o/other", 6, "Ready"), card("o/web", 7, null),
    ] } } } } });
  }) as unknown as typeof fetch;
  const rows = await makeGitHub(f).board([target("web", "o/web", 2), target("api", "o/api", 2), { name: "gl", projectPath: "g/x", stuckMinutes: {} }]);
  expect(reads).toBe(1);
  expect(rows.map((r) => [r.target, r.ticket, r.state])).toEqual([["web", "1", "factory_ready"], ["web", "2", "factory_needs_approval"], ["api", "5", "factory_running"]]);
});

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
  expect(await gh.canWrite("ann", [{ name: "gl", projectPath: "g/x", stuckMinutes: {} }])).toBe(false);
});
