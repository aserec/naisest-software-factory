import { beforeEach, describe, expect, it, vi } from "vitest";
import { ciContract, ciEvent } from "../contracts/ci.contract";
import { openDb } from "../db";
import { NotSetUp } from "../not-set-up";
import { makeGitLabCi } from "./gitlab-ci";

const READ = "read-token";
const CANCEL = "cancel-token";
beforeEach(() => {
  vi.stubEnv("FACTORY_PROJECT_ID", "42");
  vi.stubEnv("GITLAB_URL", "https://gitlab.test");
  vi.stubEnv("GITLAB_READ_TOKEN", READ);
  vi.stubEnv("GITLAB_CANCEL_TOKEN", CANCEL);
  vi.stubEnv("FACTORY_TRIGGER_TOKEN", "trigger-token");
});

type Call = { url: string; method: string; token: string | undefined; body?: string };
// A fake GitLab. `routes` maps a URL fragment to the Response to give; the first match wins.
function fakeFetch(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? "GET", token: (init?.headers as Record<string, string> | undefined)?.["PRIVATE-TOKEN"], body: init?.body?.toString() });
    const hit = Object.keys(routes).find((k) => u.includes(k));
    return hit ? routes[hit]() : new Response("?", { status: 404 });
  }) as typeof fetch;
  return { fn, calls };
}

// A fake GitLab holding `seed`, for the contract.
ciContract("GitLab CI", (seed) => {
  let refusing = false;
  const write = (r: Response) => (refusing ? new Response("no", { status: 500 }) : r);
  const { fn, calls } = fakeFetch({
    "/trigger/pipeline": () => write(Response.json({})),
    "/cancel": () => write(Response.json({})),
    "/jobs?scope[]=running": () => Response.json(seed.jobs.map((j) => ({ id: Number(j.job), name: j.name, pipeline: { id: Number(j.run) }, started_at: j.startedAt, runner: { description: j.runner } }))),
    ...Object.fromEntries(seed.jobs.map((j) => [`/jobs/${j.job}/trace`, () => new Response(j.log)])),
    "/pipelines?": () => Response.json([{ id: 7 }]),
    "/pipelines/7/jobs": () => Response.json(seed.events.length ? [{ id: 99 }] : []),
    "/jobs/99/artifacts/run/events.jsonl": () => new Response(seed.events.map((e) => JSON.stringify(e)).join("\n")),
  });
  return {
    ci: makeGitLabCi(fn),
    cancelled: () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/cancel")).map((c) => /pipelines\/(\d+)\/cancel/.exec(c.url)![1]),
    dispatched: () => calls.filter((c) => c.url.endsWith("/trigger/pipeline")).map((c) => new URLSearchParams(c.body).get("variables[FACTORY_TARGET]")!),
    refuse: () => void (refusing = true),
  };
}, { listsJobs: true });

describe("the base URL", () => {
  it("is not set up without GITLAB_URL, for every call", async () => {
    vi.stubEnv("GITLAB_URL", "");
    const { fn, calls } = fakeFetch({});
    const ci = makeGitLabCi(fn);
    for (const call of [() => ci.runningJobs(), () => ci.jobLog("1"), () => ci.cancel("1"), () => ci.startDispatch("t"), () => ci.importEvents(openDb(":memory:"))]) await expect(call()).rejects.toBeInstanceOf(NotSetUp);
    expect(calls).toHaveLength(0);
  });

  it("drops trailing slashes", async () => {
    vi.stubEnv("GITLAB_URL", "https://gitlab.test//");
    const { fn, calls } = fakeFetch({ "/trace": () => new Response("x") });
    await makeGitLabCi(fn).jobLog("1");
    expect(calls[0].url).toBe("https://gitlab.test/api/v4/projects/42/jobs/1/trace");
  });
});

describe("timeouts", () => {
  it("gives every GitLab call a timeout, so a hung GitLab cannot hold up the loop", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const fn = (async (_url: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal);
      return Response.json([]);
    }) as typeof fetch;
    const ci = makeGitLabCi(fn);
    await ci.cancel("1");
    await ci.startDispatch("demo");
    await ci.runningJobs();
    await ci.importEvents(openDb(":memory:"));
    expect(signals).toHaveLength(4);
    for (const s of signals) expect(s).toBeInstanceOf(AbortSignal);
  });
});

describe("ids", () => {
  it("refuses an id that is not all digits", async () => {
    const { fn, calls } = fakeFetch({});
    const gl = makeGitLabCi(fn);
    await expect(gl.jobLog("1/../2")).rejects.toThrow();
    await expect(gl.cancel("7?x=1")).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("jobLog", () => {
  it("returns the last 200 KB of the trace", async () => {
    const { fn, calls } = fakeFetch({ "/jobs/9/trace": () => new Response("a".repeat(300_000) + "END") });
    const log = await makeGitLabCi(fn).jobLog("9");
    expect(calls[0].url).toBe("https://gitlab.test/api/v4/projects/42/jobs/9/trace");
    expect(log).toHaveLength(200_000);
    expect(log.endsWith("END")).toBe(true);
  });
});

describe("runningJobs", () => {
  it("maps the running jobs of the factory project", async () => {
    const { fn, calls } = fakeFetch({ "/jobs": () => Response.json([{ id: 3, name: "run", pipeline: { id: 8 }, started_at: "2026-10-29T10:00:00Z", runner: { description: "r1" } }]) });
    expect(await makeGitLabCi(fn).runningJobs()).toEqual([{ job: "3", name: "run", run: "8", startedAt: "2026-10-29T10:00:00Z", runner: "r1" }]);
    expect(calls[0].url).toContain("/projects/42/jobs?scope[]=running");
  });

  it("says what a 404 means instead of showing the API path", async () => {
    const { fn } = fakeFetch({ "/jobs": () => new Response("", { status: 404 }) });
    await expect(makeGitLabCi(fn).runningJobs()).rejects.toThrow("GitLab finds no project 42 for the read token. Check FACTORY_PROJECT_ID and GITLAB_READ_TOKEN.");
  });

  it("is not set up without FACTORY_PROJECT_ID", async () => {
    vi.stubEnv("FACTORY_PROJECT_ID", "");
    await expect(makeGitLabCi(fakeFetch({}).fn).runningJobs()).rejects.toBeInstanceOf(NotSetUp);
  });
});

describe("cancel", () => {
  it("is the only call that uses the cancel token", async () => {
    const { fn, calls } = fakeFetch({ "/pipelines/7/cancel": () => Response.json({}), "/trace": () => new Response("x"), "/jobs": () => Response.json([]) });
    const gl = makeGitLabCi(fn);
    await gl.cancel("7");
    await gl.jobLog("1");
    await gl.runningJobs();
    const withCancel = calls.filter((c) => c.token === CANCEL);
    expect(withCancel).toEqual([{ url: "https://gitlab.test/api/v4/projects/42/pipelines/7/cancel", method: "POST", token: CANCEL }]);
  });

  it("throws when GitLab refuses", async () => {
    const { fn } = fakeFetch({ "/cancel": () => new Response("no", { status: 403 }) });
    await expect(makeGitLabCi(fn).cancel("7")).rejects.toThrow();
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
    const gl = makeGitLabCi(fn, () => new Date("2026-10-29T12:00:00Z"));
    expect(await gl.importEvents(db)).toBe(2);
    expect(calls.find((c) => c.url.includes("/pipelines?"))?.url).toContain("updated_after=2026-10-28T12%3A00%3A00.000Z");
    const stored = db.events({}).events;
    expect(stored.map((e) => e.data)).toEqual([{ message: "m1" }, { message: "m2" }]);

    const artifactCalls = () => calls.filter((c) => c.url.includes("/artifacts/")).length;
    expect(artifactCalls()).toBe(2);
    expect(await gl.importEvents(db)).toBe(0);
    expect(artifactCalls()).toBe(2);
  });

  it("reads every page of pipelines and of jobs", async () => {
    const page = (body: unknown, next?: string) => Response.json(body, { headers: next ? { "X-Next-Page": next } : {} });
    const { fn } = fakeFetch({
      "/pipelines?updated_after": () => page([{ id: 7 }], "2"),
      "/pipelines/7/jobs?scope[]=success&scope[]=failed&scope[]=canceled&per_page=100&page=1": () => page([{ id: 11 }], "2"),
      "/pipelines/7/jobs?scope[]=success&scope[]=failed&scope[]=canceled&per_page=100&page=2": () => page([{ id: 12 }]),
      "/pipelines/8/jobs": () => page([{ id: 13 }]),
      "/artifacts/run/events.jsonl": () => new Response(JSON.stringify(ev(1))),
    });
    // The second pipelines page: the first route matches every pipelines call, so serve page 2 from a wrapper.
    const paged = (async (url: string | URL | Request, init?: RequestInit) =>
      String(url).includes("/pipelines?") && String(url).endsWith("&page=2") ? page([{ id: 8 }]) : fn(url, init)) as typeof fetch;
    expect(await makeGitLabCi(paged).importEvents(openDb(":memory:"))).toBe(3);
  });
});
