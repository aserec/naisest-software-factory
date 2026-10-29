import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "./db";
import { makeGitLab } from "./gitlab";
import { readTargets } from "./targets";

const READ = "read-token";
const CANCEL = "cancel-token";
beforeEach(() => {
  vi.stubEnv("FACTORY_PROJECT_ID", "42");
  vi.stubEnv("GITLAB_URL", "https://gitlab.test");
  vi.stubEnv("GITLAB_READ_TOKEN", READ);
  vi.stubEnv("GITLAB_CANCEL_TOKEN", CANCEL);
  vi.stubEnv("TARGETS_DIR", targetsDir("name: t1\nprojectPath: g/t1\n", "name: t2\nprojectPath: g/t2\n"));
});

function targetsDir(...files: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "targets-"));
  files.forEach((f, i) => writeFileSync(join(dir, `t${i + 1}.yml`), f));
  return dir;
}

type Call = { url: string; method: string; token: string | undefined };
// A fake GitLab. `routes` maps a URL fragment to the Response to give; the first match wins.
function fakeFetch(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? "GET", token: (init?.headers as Record<string, string> | undefined)?.["PRIVATE-TOKEN"] });
    const hit = Object.keys(routes).find((k) => u.includes(k));
    return hit ? routes[hit]() : new Response("?", { status: 404 });
  }) as typeof fetch;
  return { fn, calls };
}

describe("board", () => {
  it("makes one call per state label per target and caches for 15 s", async () => {
    const { fn, calls } = fakeFetch({
      "labels=factory_ready": () => Response.json([{ iid: 5, title: "Fix it", web_url: "https://gitlab.test/g/t1/-/issues/5", updated_at: "2026-10-29T10:00:00Z" }]),
      "/issues": () => Response.json([]),
    });
    let t = 1_000_000;
    const gl = makeGitLab(fn, () => new Date(t));
    const rows = await gl.board();
    expect(calls).toHaveLength(16);
    expect(rows).toContainEqual({ target: "t1", ticket: "5", title: "Fix it", state: "factory_ready", url: "https://gitlab.test/g/t1/-/issues/5", updatedAt: "2026-10-29T10:00:00Z" });
    expect(calls[0].url).toContain("/projects/g%2Ft1/issues");
    expect(calls.every((c) => c.token === READ)).toBe(true);

    t += 14_000;
    await gl.board();
    expect(calls).toHaveLength(16);
    t += 2_000;
    await gl.board();
    expect(calls).toHaveLength(32);
  });
});

describe("ids", () => {
  it("refuses an id that is not all digits", async () => {
    const { fn, calls } = fakeFetch({});
    const gl = makeGitLab(fn);
    await expect(gl.jobLog("1/../2")).rejects.toThrow();
    await expect(gl.cancelPipeline("7?x=1")).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("jobLog", () => {
  it("returns the last 200 KB of the trace", async () => {
    const { fn, calls } = fakeFetch({ "/jobs/9/trace": () => new Response("a".repeat(300_000) + "END") });
    const log = await makeGitLab(fn).jobLog("9");
    expect(calls[0].url).toBe("https://gitlab.test/api/v4/projects/42/jobs/9/trace");
    expect(log).toHaveLength(200_000);
    expect(log.endsWith("END")).toBe(true);
  });
});

describe("runningJobs", () => {
  it("maps the running jobs of the factory project", async () => {
    const { fn, calls } = fakeFetch({ "/jobs": () => Response.json([{ id: 3, name: "run", pipeline: { id: 8 }, started_at: "2026-10-29T10:00:00Z", runner: { description: "r1" } }]) });
    expect(await makeGitLab(fn).runningJobs()).toEqual([{ job: "3", name: "run", pipeline: "8", startedAt: "2026-10-29T10:00:00Z", runner: "r1" }]);
    expect(calls[0].url).toContain("/projects/42/jobs?scope[]=running");
  });
});

describe("cancelPipeline", () => {
  it("is the only call that uses the cancel token", async () => {
    const { fn, calls } = fakeFetch({ "/pipelines/7/cancel": () => Response.json({}), "/trace": () => new Response("x"), "/issues": () => Response.json([]), "/jobs": () => Response.json([]) });
    const gl = makeGitLab(fn);
    await gl.cancelPipeline("7");
    await gl.jobLog("1");
    await gl.board();
    await gl.runningJobs();
    const withCancel = calls.filter((c) => c.token === CANCEL);
    expect(withCancel).toEqual([{ url: "https://gitlab.test/api/v4/projects/42/pipelines/7/cancel", method: "POST", token: CANCEL }]);
  });

  it("throws when GitLab refuses", async () => {
    const { fn } = fakeFetch({ "/cancel": () => new Response("no", { status: 403 }) });
    await expect(makeGitLab(fn).cancelPipeline("7")).rejects.toThrow();
  });
});

describe("importEvents", () => {
  const ev = (n: number) => ({ id: crypto.randomUUID(), run: "r1", at: "2026-10-29T10:00:00.000Z", target: "t1", ticket: "5", type: "error", data: { message: `m${n}`, extra: "dropped" } });
  const jobs = [{ id: 11 }, { id: 12 }];

  it("adds the good lines, skips the bad one and the dashboard's own types, and never fetches a job twice", async () => {
    const own = { ...ev(3), type: "stop", data: { user: "x" } }; // the dashboard's own audit type
    const file = [JSON.stringify(ev(1)), "not json", JSON.stringify(own), JSON.stringify(ev(2))].join("\n");
    const { fn, calls } = fakeFetch({
      "/pipelines?": () => Response.json([{ id: 7 }]),
      "/pipelines/7/jobs": () => Response.json(jobs),
      "/jobs/11/artifacts/run/events.jsonl": () => new Response(file),
      "/jobs/12/artifacts/run/events.jsonl": () => new Response("gone", { status: 404 }),
    });
    const db = openDb(":memory:");
    const gl = makeGitLab(fn, () => new Date("2026-10-29T12:00:00Z"));
    expect(await gl.importEvents(db)).toBe(2);
    expect(calls.find((c) => c.url.includes("/pipelines?"))?.url).toContain("updated_after=2026-10-28T12%3A00%3A00.000Z");
    const stored = db.events({}).events;
    expect(stored.map((e) => e.data)).toEqual([{ message: "m1" }, { message: "m2" }]);

    const artifactCalls = () => calls.filter((c) => c.url.includes("/artifacts/")).length;
    expect(artifactCalls()).toBe(2);
    expect(await gl.importEvents(db)).toBe(0);
    expect(artifactCalls()).toBe(2);
  });
});

describe("readTargets", () => {
  it("gives the default stuck minutes and lets the file override one", () => {
    const dir = targetsDir("name: a\nprojectPath: g/a\n", "name: b\nprojectPath: g/b\nstuckMinutes:\n  prepare-patch: 60\n");
    const [a, b] = readTargets(dir);
    expect(a).toMatchObject({ name: "a", projectPath: "g/a" });
    expect(a.stuckMinutes["prepare-patch"]).toBe(120);
    expect(b.stuckMinutes["prepare-patch"]).toBe(60);
    expect(b.stuckMinutes.triage).toBe(5);
  });

  it("reads TARGETS_DIR when no dir is given", () => {
    expect(readTargets().map((t) => t.name)).toEqual(["t1", "t2"]);
  });
});
