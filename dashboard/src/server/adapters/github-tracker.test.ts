import { beforeEach, expect, it, vi } from "vitest";
import { trackerContract, type Seed } from "../contracts/tracker.contract";
import type { TargetInfo } from "../targets";
import { makeGitHubTracker } from "./github-tracker";

beforeEach(() => vi.stubEnv("GITHUB_READ_TOKEN", "read-token"));

const target = (name: string, repo: string, project?: number): TargetInfo => ({ name, projectPath: repo, stuckMinutes: {}, tracker: project ? "github-project" : "github", codeHost: "github", githubRepo: repo, ...(project ? { githubProject: project } : {}) });
const card = (repo: string, number: number, status: string | null, state = "OPEN", labels: string[] = [], title = `T${number}`) => ({
  updatedAt: "2026-11-03T10:00:00Z", fieldValueByName: status ? { name: status } : null,
  content: { number, title, url: `https://github.com/${repo}/issues/${number}`, state, repository: { nameWithOwner: repo }, labels: { nodes: labels.map((name) => ({ name })) } },
});
const graphql = (nodes: unknown[]) => Response.json({ data: { repositoryOwner: { projectV2: { url: "https://github.com/users/o/projects/1", items: { pageInfo: { hasNextPage: false }, nodes } } } } });
const riskLabels = (s: Seed) => (s.risk ? [`factory_risk_${s.risk}`] : []);

// A fake GitHub holding `seed` in o/r: as labeled issues, and as cards in board columns ("needs_approval" -> "Needs approval").
const fakeGitHub = (seed: Seed[]) =>
  vi.fn(async (url: string) => {
    if (url.endsWith("/graphql")) return graphql(seed.map((s) => card("o/r", Number(s.ticket), s.state[0].toUpperCase() + s.state.slice(1).replace("_", " "), s.closed ? "CLOSED" : "OPEN", riskLabels(s), s.title)));
    const label = new URL(url).searchParams.get("labels");
    return Response.json(seed.filter((s) => `factory_${s.state}` === label).map((s) => ({ number: Number(s.ticket), title: s.title, html_url: `https://github.com/o/r/issues/${s.ticket}`, updated_at: "2026-11-03T10:00:00Z", state: s.closed ? "closed" : "open", labels: [label, ...riskLabels(s)].map((name) => ({ name })) })));
  }) as unknown as typeof fetch;

for (const project of [undefined, 2])
  trackerContract(project ? "GitHub board" : "GitHub issues", (seed, { setUp }) => {
    if (!setUp) vi.stubEnv("GITHUB_READ_TOKEN", "");
    return { tracker: makeGitHubTracker(fakeGitHub(seed)), target: target("a", "o/r", project) };
  });

it("reads a shared GitHub board once and gives each target its issue cards in factory columns, closed ones too", async () => {
  let reads = 0;
  const f = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe("https://ghe.test/api/graphql");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer read-token");
    reads++;
    return graphql([
      card("o/web", 1, "Ready"), card("o/web", 2, "Needs approval", "OPEN", ["bug", "factory_risk_medium"]), card("o/web", 3, "Backlog"), card("o/web", 4, "Done", "CLOSED"),
      card("o/api", 5, "Running"), card("o/other", 6, "Ready"), card("o/web", 7, null),
    ]);
  }) as unknown as typeof fetch;
  vi.stubEnv("GITHUB_API_URL", "https://ghe.test/api");
  const rows = await makeGitHubTracker(f).rows([target("web", "o/web", 2), target("api", "o/api", 2)]);
  expect(reads).toBe(1);
  expect(rows.map((r) => [r.target, r.ticket, r.state, r.risk])).toEqual([["web", "1", "ready", undefined], ["web", "2", "needs_approval", "medium"], ["web", "4", "done", undefined], ["api", "5", "running", undefined]]);
  expect(rows.find((r) => r.target === "api")?.boardUrl).toBe("https://github.com/users/o/projects/1");
});

it("reads open and closed issues, newest update first, each with a time limit", async () => {
  vi.stubEnv("GITHUB_API_URL", "");
  const f = vi.fn(async () => Response.json([])) as unknown as typeof fetch;
  await makeGitHubTracker(f).rows([target("a", "o/r")]);
  const [url, init] = vi.mocked(f).mock.calls[0] as [string, RequestInit];
  expect(url).toBe("https://api.github.com/repos/o/r/issues?labels=factory_ready&state=all&sort=updated&per_page=100");
  expect(init.signal).toBeInstanceOf(AbortSignal);
});

it("leaves pull requests out of the issue lists", async () => {
  const f = vi.fn(async (url: string) => Response.json(url.includes("factory_ready") ? [{ number: 1, title: "PR", html_url: "u", updated_at: "", labels: [], pull_request: {} }] : [])) as unknown as typeof fetch;
  expect(await makeGitHubTracker(f).rows([target("a", "o/r")])).toEqual([]);
});

it("links work items on the GITHUB_URL host", () => {
  vi.stubEnv("GITHUB_URL", "https://ghe.test/");
  expect(makeGitHubTracker().ticketUrl(target("a", "o/r"), "5")).toBe("https://ghe.test/o/r/issues/5");
});
