import { beforeEach, expect, it, vi } from "vitest";
import { trackerContract, type Seed } from "../contracts/tracker.contract";
import { NotSetUp } from "../not-set-up";
import type { TargetInfo } from "../targets";
import { changeOfMr, makeGitLabTracker } from "./gitlab-tracker";

beforeEach(() => {
  vi.stubEnv("GITLAB_URL", "https://gitlab.test/");
  vi.stubEnv("GITLAB_READ_TOKEN", "read-token");
});

const target = (name: string): TargetInfo => ({ name, projectPath: `g/${name}`, stuckMinutes: {}, tracker: "gitlab", codeHost: "gitlab" });

// A fake GitLab issues API holding `seed` for every project.
function fakeGitLab(seed: Seed[], mrs: unknown[] = []) {
  const calls: { url: string; token?: string; signal?: AbortSignal | null }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, token: (init?.headers as Record<string, string>)["PRIVATE-TOKEN"], signal: init?.signal });
    if (url.includes("/merge_requests")) return Response.json(mrs);
    const label = new URL(url).searchParams.get("labels");
    const project = decodeURIComponent(/projects\/([^/]+)\/issues/.exec(url)![1]);
    return Response.json(seed.filter((s) => `factory_${s.state}` === label).map((s) => ({
      iid: Number(s.ticket), title: s.title, web_url: `https://gitlab.test/${project}/-/issues/${s.ticket}`, updated_at: "2026-10-29T10:00:00Z", state: s.closed ? "closed" : "opened",
      labels: [label, ...(s.risk ? [`factory_risk_${s.risk}`] : [])],
    })));
  }) as unknown as typeof fetch;
  return { fn, calls };
}

trackerContract("GitLab", (seed, { setUp }) => {
  if (!setUp) vi.stubEnv("GITLAB_URL", "");
  return { tracker: makeGitLabTracker(fakeGitLab(seed).fn), target: target("a") };
});

it("makes one call per state label and one for the open merge requests per target, newest update first, all with the read token and a time limit", async () => {
  const { fn, calls } = fakeGitLab([{ ticket: "5", title: "Fix it", state: "ready", risk: "high" }]);
  const rows = await makeGitLabTracker(fn).rows([target("t1"), target("t2")]);
  expect(calls).toHaveLength(18);
  expect(rows).toContainEqual({ target: "t1", ticket: "5", title: "Fix it", state: "ready", url: "https://gitlab.test/g/t1/-/issues/5", updatedAt: "2026-10-29T10:00:00Z", risk: "high", boardUrl: "https://gitlab.test/g/t1/-/boards", closed: false, conflicts: false });
  expect(calls.map((c) => c.url)).toContain("https://gitlab.test/api/v4/projects/g%2Ft1/issues?labels=factory_ready&order_by=updated_at&per_page=100");
  expect(calls.every((c) => c.token === "read-token" && c.signal instanceof AbortSignal)).toBe(true);
});

it("is not set up without a read token, and makes no call", async () => {
  vi.stubEnv("GITLAB_READ_TOKEN", "");
  const { fn, calls } = fakeGitLab([]);
  await expect(makeGitLabTracker(fn).rows([target("t1")])).rejects.toBeInstanceOf(NotSetUp);
  expect(calls).toHaveLength(0);
});

it("gives each issue its factory merge request: the link, the conflicts, and why it cannot merge", async () => {
  const mr = (iid: number, branch: string, status: string, conflicts = false) => ({ iid, web_url: `https://gitlab.test/g/a/-/merge_requests/${iid}`, source_branch: branch, has_conflicts: conflicts, detailed_merge_status: status });
  const { fn } = fakeGitLab(
    ["5", "6", "7", "8"].map((ticket) => ({ ticket, title: `T${ticket}`, state: "needs_approval" as const })),
    [mr(1, "factory/5-fix", "conflict", true), mr(2, "factory/6-docs", "mergeable"), mr(3, "factory/7-old", "ci_must_pass"), mr(4, "factory/7-new", "checking"), mr(5, "factory/55-other", "conflict", true)],
  );
  const rows = await makeGitLabTracker(fn).rows([target("a")]);
  const of = (t: string) => { const r = rows.find((x) => x.ticket === t)!; return { changeUrl: r.changeUrl, conflicts: r.conflicts, mergeBlock: r.mergeBlock }; };
  expect(["5", "6", "7", "8"].map((t) => rows.find((x) => x.ticket === t)!.checksFailed)).toEqual([false, false, false, undefined]);
  expect(changeOfMr(mr(9, "factory/9-x", "ci_must_pass")).checksFailed).toBe(true);
  expect(of("5")).toEqual({ changeUrl: "https://gitlab.test/g/a/-/merge_requests/1", conflicts: true, mergeBlock: "it has conflicts with the base branch" });
  expect(of("6")).toEqual({ changeUrl: "https://gitlab.test/g/a/-/merge_requests/2", conflicts: false, mergeBlock: undefined });
  expect(of("7")).toEqual({ changeUrl: "https://gitlab.test/g/a/-/merge_requests/4", conflicts: undefined, mergeBlock: undefined }); // the newest merge request wins; still checking
  expect(of("8")).toEqual({ changeUrl: undefined, conflicts: false, mergeBlock: undefined });
});
