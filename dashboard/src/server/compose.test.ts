import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { DETAILS_MS } from "./adapters/github-tracker";
import { CACHE_MS, codeHostName, makeBoard, trackerOf } from "./compose";
import { NotSetUp } from "./not-set-up";
import { readTargets } from "./targets";

beforeEach(() => {
  vi.stubEnv("GITLAB_URL", "https://gitlab.test");
  vi.stubEnv("GITLAB_READ_TOKEN", "gl-read");
  vi.stubEnv("GITHUB_READ_TOKEN", "gh-read");
  const dir = mkdtempSync(join(tmpdir(), "targets-"));
  writeFileSync(join(dir, "a.yml"), "name: a\nprojectPath: g/a\n");
  writeFileSync(join(dir, "b.yml"), "name: b\nprojectPath: o/r\ntracker: github\ngithubRepo: o/r\n");
  vi.stubEnv("TARGETS_DIR", dir);
});

// GitLab has one ready issue for a, GitHub one running issue for b; every other list is empty.
const fakeFetch = () =>
  vi.fn(async (url: string) => {
    if (url.startsWith("https://gitlab.test/api/v4/projects/g%2Fa/issues?labels=factory_ready"))
      return Response.json([{ iid: 4, title: "GL", web_url: "https://gitlab.test/g/a/-/issues/4", updated_at: "2026-11-04T10:00:00Z", labels: ["factory_ready"] }]);
    if (url.startsWith("https://api.github.com/repos/o/r/issues?labels=factory_running"))
      return Response.json([{ number: 5, title: "GH", html_url: "https://github.com/o/r/issues/5", updated_at: "2026-11-04T10:00:00Z", labels: [{ name: "factory_running" }] }]);
    return Response.json([]);
  }) as unknown as typeof fetch;

it("a mixed board shows GitLab and GitHub targets, each with its own link", async () => {
  const rows = await makeBoard(fakeFetch()).board();
  expect(rows.map((r) => [r.target, r.ticket, r.state, r.url])).toEqual([
    ["a", "4", "ready", "https://gitlab.test/g/a/-/issues/4"],
    ["b", "5", "running", "https://github.com/o/r/issues/5"],
  ]);
  const b = readTargets().find((t) => t.name === "b")!;
  expect(trackerOf(b).ticketUrl(b, "5")).toBe("https://github.com/o/r/issues/5");
});

it("a GitLab target with no GITLAB_URL is left out and the GitHub target still shows", async () => {
  vi.stubEnv("GITLAB_URL", "");
  const rows = await makeBoard(fakeFetch()).board();
  expect(rows.map((r) => r.target)).toEqual(["b"]);
});

it("another error fails the board", async () => {
  const f = vi.fn(async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
  await expect(makeBoard(f).board()).rejects.toThrow();
});

it("Refresh of one target reads only that target's tracker and keeps the other rows", async () => {
  const f = fakeFetch();
  const board = makeBoard(f);
  await board.board();
  vi.mocked(f).mockClear();
  const rows = await board.board(true, "b");
  const urls = vi.mocked(f).mock.calls.map((c) => String(c[0]));
  expect(urls.length).toBeGreaterThan(0);
  expect(urls.every((u) => u.startsWith("https://api.github.com/"))).toBe(true);
  expect(rows.map((r) => [r.target, r.ticket])).toEqual([["a", "4"], ["b", "5"]]);
  expect((await board.board()).map((r) => r.target)).toEqual(["a", "b"]); // the merged board is the cached one
});

it("the board is cached for CACHE_MS and a failure is not cached", async () => {
  const f = fakeFetch();
  let t = 1_000_000;
  const board = makeBoard(f, () => new Date(t));
  await board.board();
  const calls = vi.mocked(f).mock.calls.length;
  t += CACHE_MS - 1_000;
  await board.board();
  expect(vi.mocked(f).mock.calls.length).toBe(calls);
  t += DETAILS_MS; // past the GitHub tracker's own cache of the labeled issues too
  await board.board();
  await new Promise((r) => setTimeout(r, 0)); // the new read runs behind the answer
  expect(vi.mocked(f).mock.calls.length).toBe(2 * calls);
  await board.board(true); // Refresh skips the cache
  expect(vi.mocked(f).mock.calls.length).toBe(3 * calls);

  vi.mocked(f).mockResolvedValueOnce(new Response("no", { status: 500 }));
  t += CACHE_MS + 1_000;
  await expect(board.board(true)).rejects.toThrow();
  const failed = vi.mocked(f).mock.calls.length;
  t += DETAILS_MS; // the GitHub tracker keeps its labeled issues that long, even when the GitLab read failed
  await board.board();
  await new Promise((r) => setTimeout(r, 0));
  expect(vi.mocked(f).mock.calls.length).toBe(failed + calls);
});

it("past CACHE_MS the board answers with the last one at once and reads the new one behind it", async () => {
  let t = 1_000_000;
  let release = () => {};
  const f = vi.fn(fakeFetch());
  const board = makeBoard(f, () => new Date(t));
  const first = await board.board();

  t += CACHE_MS + 1_000;
  const gate = new Promise<void>((r) => (release = r));
  const real = f.getMockImplementation()!;
  f.mockImplementation(async (...a) => (await gate, real(...a)));
  expect(await board.board()).toBe(first); // no wait for the slow read
  release();
  await new Promise((r) => setTimeout(r, 0));

  t += 11 * 60_000; // too old to show: the request waits for the read and sees its error
  f.mockImplementation(async () => new Response("no", { status: 500 }));
  await expect(board.board()).rejects.toThrow();
});

it("codeHostName gives the target's code host name", () => {
  const [a, b] = readTargets();
  expect(codeHostName({ ...b, codeHost: "github" })).toBe("GitHub");
  expect(codeHostName(a)).toBe("GitLab");
});

it("FACTORY_CI=local picks the worker, and getCi is one instance", async () => {
  vi.stubEnv("FACTORY_CI", "local");
  const { getCi } = await import("./compose");
  await expect(getCi().runningJobs()).rejects.toBeInstanceOf(NotSetUp);
  expect(getCi()).toBe(getCi());
});

it("no FACTORY_CI gives a CI that cancels and dispatches nothing", async () => {
  const { makeNoCi } = await import("./compose");
  await expect(makeNoCi().cancel("7")).rejects.toThrow("FACTORY_CI is not set");
  await expect(makeNoCi().startDispatch("demo")).rejects.toBeInstanceOf(NotSetUp);
});

it("no GRAFANA_URL gives no log sources and a not-set-up answer", async () => {
  vi.stubEnv("GRAFANA_URL", "");
  const { getHostMetrics } = await import("./compose");
  const m = getHostMetrics();
  expect(m.sources).toEqual([]);
  await expect(m.hostStats()).rejects.toThrow("Grafana is not set up. Set GRAFANA_URL");
  await expect(m.logs({ source: "docker", minutes: 5 })).rejects.toBeInstanceOf(NotSetUp);
});

it("GRAFANA_URL picks Grafana with its three log sources", async () => {
  vi.stubEnv("GRAFANA_URL", "https://ops.example");
  const { getHostMetrics } = await import("./compose");
  expect(getHostMetrics().sources).toEqual(["docker", "gitlab-runner", "system"]);
});
