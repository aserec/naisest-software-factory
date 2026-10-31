import { beforeEach, describe, expect, test } from "vitest";
import { AI_LINE, GitLab } from "./gitlab";
import { NotFactoryRunError } from "./seams";

let calls: { url: string; init: RequestInit }[] = [];
let next: { status?: number; body?: unknown; headers?: Record<string, string> } = {};
const fakeFetch = (async (url: string, init: RequestInit) => {
  calls.push({ url, init });
  return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200, headers: next.headers });
}) as unknown as typeof fetch;
const fakeResponse = (body: unknown, status = 200, headers?: Record<string, string>) => (next = { body, status, headers });
const last = () => calls[calls.length - 1];
const lastBody = () => JSON.parse(last().init.body as string);
let gl: GitLab;

beforeEach(() => {
  calls = [];
  next = {};
  gl = new GitLab("https://gl.example", "tok", fakeFetch);
});

test("setState removes every other state label", async () => {
  await gl.setState(1, 8, "factory_running");
  expect(lastBody()).toMatchObject({ add_labels: "factory_running", remove_labels: expect.stringContaining("factory_ready") });
  expect(lastBody().remove_labels).not.toContain("factory_running");
  expect(last().url).toBe("https://gl.example/api/v4/projects/1/issues/8");
  expect((last().init.headers as Record<string, string>)["PRIVATE-TOKEN"]).toBe("tok");
});
test("comments start with the AI line", async () => {
  await gl.comment(1, 8, "Triage done.");
  expect(lastBody().body.startsWith(AI_LINE)).toBe(true);
});
test("a comment holding a GitLab token is refused and not sent", async () => {
  await expect(gl.comment(1, 8, "token glpat-abcdefghijklmnopqrst")).rejects.toThrow(/secret/);
  expect(calls).toHaveLength(0);
});
test("default branch comes from the API, not 'main'", async () => {
  fakeResponse({ id: 7, default_branch: "master" });
  expect(await gl.getProject("acme/web/react_frontend")).toEqual({ id: 7, defaultBranch: "master" });
  expect(last().url).toContain("acme%2Fapplications%2Fweb%2Ffrontend%2Freact_frontend");
});
test("a failed call names the status and endpoint but not the token", async () => {
  fakeResponse({}, 500);
  const err = (await gl.getProject("a/b").catch((e) => e)) as Error;
  expect(err.message).toContain("500");
  expect(err.message).toContain("/projects/a%2Fb");
  expect(err.message).not.toContain("tok");
});
test("memberAccessLevel is 0 on 404", async () => {
  fakeResponse({}, 404);
  expect(await gl.memberAccessLevel(1, 5)).toBe(0);
  fakeResponse({ access_level: 30 });
  expect(await gl.memberAccessLevel(1, 5)).toBe(30);
});
test("pipelineStatus maps anything else to running", async () => {
  fakeResponse([{ status: "success" }]);
  expect(await gl.pipelineStatus(1, "b", "abc")).toBe("success");
  fakeResponse([{ status: "pending" }]);
  expect(await gl.pipelineStatus(1, "b", "abc")).toBe("running");
  fakeResponse([]);
  expect(await gl.pipelineStatus(1, "b", "abc")).toBe("running");
});
test("pipelineStatus: a canceled or skipped pipeline is none, it will never give a result", async () => {
  fakeResponse([{ status: "canceled" }]);
  expect(await gl.pipelineStatus(1, "b", "abc")).toBe("none");
  fakeResponse([{ status: "skipped" }]);
  expect(await gl.pipelineStatus(1, "b", "abc")).toBe("none");
});
test("mergeRequestPipelineStatus reads the newest MR pipeline; canceled is failed, none is running", async () => {
  fakeResponse([{ status: "success", sha: "h" }, { status: "failed", sha: "h" }]);
  expect(await gl.mergeRequestPipelineStatus(1, 2, "h")).toBe("success");
  expect(last().url).toBe("https://gl.example/api/v4/projects/1/merge_requests/2/pipelines");
  fakeResponse([{ status: "canceled", sha: "h" }, { status: "success", sha: "h" }]);
  expect(await gl.mergeRequestPipelineStatus(1, 2, "h")).toBe("failed");
  fakeResponse([{ status: "failed", sha: "h" }]);
  expect(await gl.mergeRequestPipelineStatus(1, 2, "h")).toBe("failed");
  fakeResponse([{ status: "pending", sha: "h" }]);
  expect(await gl.mergeRequestPipelineStatus(1, 2, "h")).toBe("running");
  fakeResponse([]);
  expect(await gl.mergeRequestPipelineStatus(1, 2, "h")).toBe("running");
});
test("mergeRequestPipelineStatus counts only a pipeline for the head sha", async () => {
  fakeResponse([{ status: "success", sha: "older" }]);
  expect(await gl.mergeRequestPipelineStatus(1, 2, "head")).toBe("running");
  fakeResponse([{ status: "failed", sha: "older" }]);
  expect(await gl.mergeRequestPipelineStatus(1, 2, "head")).toBe("running");
});
test("merge squashes with the given message and returns the commit that landed", async () => {
  fakeResponse({ merge_commit_sha: null, squash_commit_sha: "sq1", sha: "head" });
  expect(await gl.merge(1, 2, "head", "[AM] feat(list): x")).toBe("sq1");
  expect(lastBody()).toEqual({ sha: "head", squash: true, squash_commit_message: "[AM] feat(list): x" });
  expect(last().url).toBe("https://gl.example/api/v4/projects/1/merge_requests/2/merge");
  expect(last().init.method).toBe("PUT");
  fakeResponse({ merge_commit_sha: "m1", sha: "head" });
  expect(await gl.merge(1, 2, "head", "[AM] feat(list): x")).toBe("m1");
});
test("MR comments start with the AI line and refuse secrets", async () => {
  await gl.commentMergeRequest(1, 2, "Reasons");
  expect(last().url).toBe("https://gl.example/api/v4/projects/1/merge_requests/2/notes");
  expect(lastBody().body.startsWith(AI_LINE)).toBe(true);
  await expect(gl.commentMergeRequest(1, 2, "glpat-abcdefghijklmnopqrst")).rejects.toThrow(/secret/);
});
test("revertMerge opens a revert MR from a new branch off the default branch", async () => {
  fakeResponse({ iid: 9, web_url: "u9" });
  expect(await gl.revertMerge(1, "abcdef1234", "master")).toEqual({ iid: 9, webUrl: "u9" });
  const [branch, revert, mr] = calls.map((c) => ({ url: c.url, body: JSON.parse(c.init.body as string) }));
  expect(branch.url).toContain("/projects/1/repository/branches");
  expect(branch.body).toMatchObject({ branch: expect.stringMatching(/^factory\/revert-abcdef12-\d+$/), ref: "master" });
  expect(revert.url).toContain("/projects/1/repository/commits/abcdef1234/revert");
  expect(revert.body).toEqual({ branch: branch.body.branch });
  expect(mr.body).toMatchObject({ source_branch: branch.body.branch, target_branch: "master" });
  // A second revert of the same commit uses a new branch name.
  calls = [];
  await new Promise((r) => setTimeout(r, 2));
  await gl.revertMerge(1, "abcdef1234", "master");
  expect(JSON.parse(calls[0].init.body as string).branch).not.toBe(branch.body.branch);
});
test("openMergeRequest, close", async () => {
  fakeResponse({ iid: 2, web_url: "u" });
  expect(await gl.openMergeRequest(1, "br", "main", "t", "d")).toEqual({ iid: 2, webUrl: "u" });
  await gl.closeWorkItem(1, 8);
  expect(lastBody()).toEqual({ state_event: "close" });
});
test("upsertMergeRequest reuses the open MR of the branch and updates it", async () => {
  fakeResponse([{ iid: 4, web_url: "u4", target_branch: "master" }]);
  expect(await gl.upsertMergeRequest(1, "factory/8-x", "master", "t", "d")).toEqual({ iid: 4, webUrl: "u4" });
  expect(calls[0].url).toBe("https://gl.example/api/v4/projects/1/merge_requests?state=opened&source_branch=factory%2F8-x");
  expect(last().init.method).toBe("PUT");
  expect(last().url).toBe("https://gl.example/api/v4/projects/1/merge_requests/4");
  expect(lastBody()).toEqual({ title: "t", description: "d" });
});
test("upsertMergeRequest opens a new MR when none is open", async () => {
  fakeResponse([]);
  await gl.upsertMergeRequest(1, "factory/8-x", "master", "t", "d");
  expect(last().init.method).toBe("POST");
  expect(lastBody()).toMatchObject({ source_branch: "factory/8-x", target_branch: "master" });
});
test("upsertMergeRequest refuses an open MR that targets another branch", async () => {
  fakeResponse([{ iid: 4, web_url: "u4", target_branch: "release" }]);
  await expect(gl.upsertMergeRequest(1, "factory/8-x", "master", "t", "d")).rejects.toThrow(/release/);
  expect(calls).toHaveLength(1);
});

describe("buildRecord", () => {
  const pipeline = { id: 41, source: "trigger", ref: "main", user: { id: 1 } };
  const routes = (p: object) => (async (url: string) => {
    const path = url.replace("https://gl.example/api/v4", "");
    const body =
      path === "/projects/3/pipelines/41" ? p :
      path === "/projects/3" ? { id: 3, default_branch: "main" } :
      path === "/user" ? { id: 1 } :
      path.startsWith("/projects/3/pipelines/41/jobs") ? [{ id: 10, name: "decision", status: "success" }, { id: 12, name: "decision", status: "success" }, { id: 11, name: "risk-check", status: "success" }] :
      path === "/projects/3/jobs/12/artifacts/run/record.json" ? { workItem: "newest" } :
      path === "/projects/3/jobs/10/artifacts/run/record.json" ? { workItem: "older" } : undefined;
    return new Response(JSON.stringify(body ?? {}), { status: body ? 200 : 404 });
  }) as unknown as typeof fetch;

  test("reads the newest decision job of a bot-triggered pipeline on the default branch", async () => {
    expect(await new GitLab("https://gl.example", "tok", routes(pipeline)).buildRecord(3, 41)).toEqual({ workItem: "newest" });
  });
  test.each([
    ["not started by a trigger", { ...pipeline, source: "push" }],
    ["not on the default branch", { ...pipeline, ref: "evil" }],
    ["not started by the bot", { ...pipeline, user: { id: 9 } }],
  ])("rejects a pipeline %s", async (_name, p) => {
    await expect(new GitLab("https://gl.example", "tok", routes(p)).buildRecord(3, 41)).rejects.toBeInstanceOf(NotFactoryRunError);
    await expect(new GitLab("https://gl.example", "tok", routes(p)).runArtifacts(3, 41)).rejects.toBeInstanceOf(NotFactoryRunError);
  });
});

test("labelAddedBy names who last added the label", async () => {
  fakeResponse([
    { action: "add", label: { name: "factory_ready" }, user: { id: 5 } },
    { action: "add", label: { name: "bug" }, user: { id: 6 } },
    { action: "remove", label: { name: "factory_ready" }, user: { id: 7 } },
    { action: "add", label: { name: "factory_ready" }, user: { id: 8 } },
  ]);
  expect(await gl.labelAddedBy(1, 8, "factory_ready")).toBe(8);
  fakeResponse([]);
  expect(await gl.labelAddedBy(1, 8, "factory_ready")).toBeUndefined();
});
test("labelAddedBy reads every page, so the newest event counts", async () => {
  const pages: Record<string, unknown[]> = {
    "1": [{ action: "add", label: { name: "factory_ready" }, user: { id: 5 } }],
    "2": [{ action: "add", label: { name: "factory_ready" }, user: { id: 8 } }],
  };
  const fetchFn = (async (url: string) => {
    const page = new URL(url).searchParams.get("page") ?? "1";
    return new Response(JSON.stringify(pages[page]), { headers: page === "1" ? { "X-Next-Page": "2" } : { "X-Next-Page": "" } });
  }) as unknown as typeof fetch;
  expect(await new GitLab("https://gl.example", "tok", fetchFn).labelAddedBy(1, 8, "factory_ready")).toBe(8);
});
// GitLab runs quick actions from any line that starts with "/", as the bot.
const quickAction = /^\s*\//m;
test("a /merge line from test-changes.md reaches the MR description escaped, on open and on update", async () => {
  const description = "Changed tests, and why:\n\n/merge\n  /approve";
  fakeResponse([]);
  await gl.upsertMergeRequest(1, "factory/8-x", "master", "t", description);
  expect(lastBody().description).not.toMatch(quickAction);
  expect(lastBody().description).toContain("​/merge");
  fakeResponse([{ iid: 4, web_url: "u4", target_branch: "master" }]);
  await gl.upsertMergeRequest(1, "factory/8-x", "master", "t", description);
  expect(last().init.method).toBe("PUT");
  expect(lastBody().description).not.toMatch(quickAction);
});
test("a /label ~factory_ready line in a note is escaped", async () => {
  await gl.comment(1, 8, "Questions:\n/label ~factory_ready\n/close");
  expect(lastBody().body).not.toMatch(quickAction);
  expect(lastBody().body).toContain("​/label ~factory_ready");
  await gl.commentMergeRequest(1, 2, "/merge");
  expect(lastBody().body).not.toMatch(quickAction);
});
