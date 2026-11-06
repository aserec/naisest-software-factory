import { beforeEach, expect, it, vi } from "vitest";
import { trackerContract, type Seed } from "../contracts/tracker.contract";
import { NotSetUp } from "../not-set-up";
import type { TargetInfo } from "../targets";
import { makeGitLabTracker } from "./gitlab-tracker";

beforeEach(() => {
  vi.stubEnv("GITLAB_URL", "https://gitlab.test/");
  vi.stubEnv("GITLAB_READ_TOKEN", "read-token");
});

const target = (name: string): TargetInfo => ({ name, projectPath: `g/${name}`, stuckMinutes: {}, tracker: "gitlab", codeHost: "gitlab" });

// A fake GitLab issues API holding `seed` for every project.
function fakeGitLab(seed: Seed[]) {
  const calls: { url: string; token?: string; signal?: AbortSignal | null }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, token: (init?.headers as Record<string, string>)["PRIVATE-TOKEN"], signal: init?.signal });
    const label = new URL(url).searchParams.get("labels");
    const project = decodeURIComponent(/projects\/([^/]+)\/issues/.exec(url)![1]);
    return Response.json(seed.filter((s) => `factory_${s.state}` === label).map((s) => ({
      iid: Number(s.ticket), title: s.title, web_url: `https://gitlab.test/${project}/-/issues/${s.ticket}`, updated_at: "2026-10-29T10:00:00Z",
      labels: [label, ...(s.risk ? [`factory_risk_${s.risk}`] : [])],
    })));
  }) as unknown as typeof fetch;
  return { fn, calls };
}

trackerContract("GitLab", (seed, { setUp }) => {
  if (!setUp) vi.stubEnv("GITLAB_URL", "");
  return { tracker: makeGitLabTracker(fakeGitLab(seed).fn), target: target("a") };
});

it("makes one call per state label per target, newest update first, all with the read token and a time limit", async () => {
  const { fn, calls } = fakeGitLab([{ ticket: "5", title: "Fix it", state: "ready", risk: "high" }]);
  const rows = await makeGitLabTracker(fn).rows([target("t1"), target("t2")]);
  expect(calls).toHaveLength(16);
  expect(rows).toContainEqual({ target: "t1", ticket: "5", title: "Fix it", state: "ready", url: "https://gitlab.test/g/t1/-/issues/5", updatedAt: "2026-10-29T10:00:00Z", risk: "high", boardUrl: "https://gitlab.test/g/t1/-/boards" });
  expect(calls[0].url).toBe("https://gitlab.test/api/v4/projects/g%2Ft1/issues?labels=factory_ready&order_by=updated_at&per_page=100");
  expect(calls.every((c) => c.token === "read-token" && c.signal instanceof AbortSignal)).toBe(true);
});

it("is not set up without a read token, and makes no call", async () => {
  vi.stubEnv("GITLAB_READ_TOKEN", "");
  const { fn, calls } = fakeGitLab([]);
  await expect(makeGitLabTracker(fn).rows([target("t1")])).rejects.toBeInstanceOf(NotSetUp);
  expect(calls).toHaveLength(0);
});
