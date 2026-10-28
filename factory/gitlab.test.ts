import { beforeEach, expect, test } from "vitest";
import { AI_LINE, GitLab } from "./gitlab";

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
test("mergeWhenGreen, openMergeRequest, close", async () => {
  await gl.mergeWhenGreen(1, 2);
  expect(lastBody()).toMatchObject({ merge_when_pipeline_succeeds: true, auto_merge: true });
  fakeResponse({ iid: 2, web_url: "u" });
  expect(await gl.openMergeRequest(1, "br", "main", "t", "d")).toEqual({ iid: 2, webUrl: "u" });
  await gl.closeWorkItem(1, 8);
  expect(lastBody()).toEqual({ state_event: "close" });
});
