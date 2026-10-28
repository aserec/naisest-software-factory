import { beforeEach, describe, expect, test } from "vitest";
import { AI_LINE, GitLab, NotFactoryPipelineError } from "./gitlab";

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
test("countLabeled reads X-Total", async () => {
  fakeResponse([], 200, { "X-Total": "3" });
  expect(await gl.countLabeled(1, "factory_running")).toBe(3);
});
test("getWorkItem maps fields", async () => {
  fakeResponse({ title: "T", description: null, labels: ["a"], assignees: [{ id: 4 }] });
  expect(await gl.getWorkItem(1, 8)).toEqual({ title: "T", description: "", labels: ["a"], assigneeIds: [4] });
});
test("pipelineStatus maps anything else to running", async () => {
  fakeResponse([{ status: "success" }]);
  expect(await gl.pipelineStatus(1, "b", "abc")).toBe("success");
  fakeResponse([{ status: "pending" }]);
  expect(await gl.pipelineStatus(1, "b", "abc")).toBe("running");
  fakeResponse([]);
  expect(await gl.pipelineStatus(1, "b", "abc")).toBe("running");
});
test("mergeRequestPipelineStatus reads the newest MR pipeline; canceled is failed, none is running", async () => {
  fakeResponse([{ status: "success" }, { status: "failed" }]);
  expect(await gl.mergeRequestPipelineStatus(1, 2)).toBe("success");
  expect(last().url).toBe("https://gl.example/api/v4/projects/1/merge_requests/2/pipelines");
  fakeResponse([{ status: "canceled" }, { status: "success" }]);
  expect(await gl.mergeRequestPipelineStatus(1, 2)).toBe("failed");
  fakeResponse([{ status: "failed" }]);
  expect(await gl.mergeRequestPipelineStatus(1, 2)).toBe("failed");
  fakeResponse([{ status: "pending" }]);
  expect(await gl.mergeRequestPipelineStatus(1, 2)).toBe("running");
  fakeResponse([]);
  expect(await gl.mergeRequestPipelineStatus(1, 2)).toBe("running");
});
test("merge returns the commit that landed on the default branch", async () => {
  fakeResponse({ merge_commit_sha: null, squash_commit_sha: "sq1", sha: "head" });
  expect(await gl.merge(1, 2, "head")).toBe("sq1");
  expect(lastBody()).toEqual({ sha: "head" });
  expect(last().url).toBe("https://gl.example/api/v4/projects/1/merge_requests/2/merge");
  expect(last().init.method).toBe("PUT");
  fakeResponse({ merge_commit_sha: "m1", sha: "head" });
  expect(await gl.merge(1, 2, "head")).toBe("m1");
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
test("approvedBy lists approver ids; getMergeRequest maps the merge commit", async () => {
  fakeResponse({ approved_by: [{ user: { id: 3 } }, { user: { id: 4 } }] });
  expect(await gl.approvedBy(1, 2)).toEqual([3, 4]);
  expect(last().url).toBe("https://gl.example/api/v4/projects/1/merge_requests/2/approvals");
  fakeResponse({ state: "merged", description: null, sha: "h", merge_commit_sha: "m" });
  expect(await gl.getMergeRequest(1, 2)).toEqual({ state: "merged", description: "", headSha: "h", mergeSha: "m" });
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
    await expect(new GitLab("https://gl.example", "tok", routes(p)).buildRecord(3, 41)).rejects.toBeInstanceOf(NotFactoryPipelineError);
  });
});
