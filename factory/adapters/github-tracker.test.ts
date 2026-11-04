import { beforeEach, describe, expect, test } from "vitest";
import { AI_LINE } from "../gitlab";
import { GitHub } from "../github";
import { makeGitHubTracker } from "./github-tracker";

const REPO = "acme/web";
let calls: { method: string; path: string; body?: any }[] = [];
let rest: Record<string, unknown> = {};
let graph: (query: string, vars: any) => unknown = () => ({});
const fakeFetch = (async (url: string, init: RequestInit) => {
  const path = url.replace("https://api.github.com", "");
  const body = init.body ? JSON.parse(init.body as string) : undefined;
  calls.push({ method: init.method!, path, body });
  if (path === "/graphql") return Response.json({ data: graph(body.query, body.variables) });
  const key = `${init.method} ${path.replace(/[?&]page=1$/, "").replace(/&page=\d+$/, "")}`;
  if (!(key in rest)) return new Response("{}", { status: init.method === "GET" ? 404 : 200 });
  return Response.json(rest[key]);
}) as unknown as typeof fetch;
const gh = new GitHub("tok", fakeFetch, async () => {});
const issue = (o: object = {}) => ({ number: 8, title: "T", body: "D", state: "open", labels: [], assignees: [], html_url: "u8", created_at: "2026-01-01", ...o });

beforeEach(() => {
  calls = [];
  rest = { "GET /user": { login: "factory-bot" } };
});

describe("labels", () => {
  const t = () => makeGitHubTracker(gh, REPO);

  test("setState removes the other state labels and adds the new one, leaving the rest", async () => {
    rest[`GET /repos/${REPO}/issues/8`] = issue({ labels: [{ name: "factory_ready" }, { name: "factory_triaged" }, { name: "bug" }] });
    await t().setState("8", "running");
    expect(calls.slice(1).map((c) => `${c.method} ${c.path}`)).toEqual([`DELETE /repos/${REPO}/issues/8/labels/factory_ready`, `POST /repos/${REPO}/issues/8/labels`]);
    expect(calls.at(-1)!.body).toEqual({ labels: ["factory_running"] });
  });

  test("clearState removes every state label and keeps the marks and other labels", async () => {
    rest[`GET /repos/${REPO}/issues/8`] = issue({ labels: [{ name: "factory_running" }, { name: "factory_implemented" }, { name: "bug" }] });
    await t().clearState("8");
    expect(calls.slice(1).map((c) => `${c.method} ${c.path}`)).toEqual([`DELETE /repos/${REPO}/issues/8/labels/factory_running`]);
  });

  test("a ticket maps state, marks and tags; pull requests are not tickets", async () => {
    rest[`GET /repos/${REPO}/issues?labels=factory_ready&state=open&sort=created&direction=asc&per_page=100`] = [
      issue({ labels: [{ name: "factory_ready" }, { name: "factory_done" }, { name: "factory_watcher" }, { name: "bug" }], assignees: [{ login: "ann" }] }),
      issue({ number: 9, pull_request: {} }),
    ];
    expect(await t().list("ready")).toEqual([{ ref: "8", title: "T", body: "D", open: true, state: "ready", ended: "done", marks: ["watcher"], tags: ["bug"], assignees: ["ann"], url: "u8" }]);
  });

  test("startedBy is whoever last added factory_ready; only write access is trusted, never the bot", async () => {
    rest[`GET /repos/${REPO}/issues/8/events?per_page=100`] = [
      { event: "labeled", label: { name: "factory_ready" }, actor: { login: "old" } },
      { event: "labeled", label: { name: "bug" }, actor: { login: "x" } },
      { event: "labeled", label: { name: "factory_ready" }, actor: { login: "ann" } },
    ];
    expect(await t().startedBy("8")).toBe("ann");
    rest[`GET /repos/${REPO}/collaborators/ann/permission`] = { permission: "write" };
    rest[`GET /repos/${REPO}/collaborators/bob/permission`] = { permission: "read" };
    rest[`GET /repos/${REPO}/collaborators/factory-bot/permission`] = { permission: "admin" };
    expect([await t().trusted("ann"), await t().trusted("bob"), await t().trusted("eve"), await t().trusted("factory-bot")]).toEqual([true, false, false, false]);
  });

  test("with a shared account, the account's person is trusted and only its comments with the AI line are the factory's", async () => {
    rest[`GET /repos/${REPO}/collaborators/factory-bot/permission`] = { permission: "admin" };
    rest[`GET /repos/${REPO}/issues/8/comments?per_page=100`] = [
      { user: { login: "factory-bot" }, body: `${AI_LINE}\n\nQuestion`, created_at: "1" },
      { user: { login: "factory-bot" }, body: "My answer", created_at: "2" },
    ];
    const shared = makeGitHubTracker(gh, REPO, undefined, true);
    expect(await shared.trusted("factory-bot")).toBe(true);
    expect((await shared.comments("8")).map((c) => c.byFactory)).toEqual([false, true]);
  });

  test("a comment with a secret is refused before any call", async () => {
    await expect(t().comment("8", "key glpat-abcdefghijklmnopqrst")).rejects.toThrow(/secret/);
    expect(calls).toEqual([]);
  });

  test("parseEvent reads ready labels, commands and merged factory PRs from this repo only", () => {
    const base = { repository: { full_name: REPO }, sender: { login: "ann" } };
    expect(t().parseEvent({ ...base, action: "labeled", label: { name: "factory_ready" }, issue: { number: 8 } })).toEqual({ kind: "ready", ticket: "8", actor: "ann" });
    expect(t().parseEvent({ ...base, action: "created", issue: { number: 8 }, comment: { body: "hi\n @Factory Stop " } })).toEqual({ kind: "command", ticket: "8", actor: "ann", command: "stop" });
    expect(t().parseEvent({ ...base, action: "closed", pull_request: { number: 3, merged: true, head: { ref: "factory/8-fix" } } })).toEqual({ kind: "merged", ticket: "8", change: "3", actor: "ann" });
    expect(t().parseEvent({ ...base, action: "closed", pull_request: { number: 3, merged: true, head: { ref: "factory/ABC-12--fix" } } })).toEqual({ kind: "merged", ticket: "ABC-12", change: "3", actor: "ann" });
    expect(t().parseEvent({ ...base, repository: { full_name: "evil/web" }, action: "labeled", label: { name: "factory_ready" }, issue: { number: 8 } })).toEqual({ kind: "ignored", reason: "other-project" });
    expect(t().parseEvent({ ...base, action: "labeled", label: { name: "bug" }, issue: { number: 8 } })).toEqual({ kind: "ignored", reason: "not-added" });
  });
});

describe("board", () => {
  const t = () => makeGitHubTracker(gh, REPO, 5);
  const project = { repositoryOwner: { projectV2: { id: "P", field: { id: "F", options: [{ id: "o-ready", name: "Ready" }, { id: "o-info", name: "Needs info" }] } } } };
  const gqlIssue = (o: object = {}) => ({ id: "I8", number: 8, title: "T", body: "D", state: "OPEN", url: "u8", createdAt: "2026-01-02", labels: { nodes: [] }, assignees: { nodes: [] }, repository: { nameWithOwner: REPO }, ...o });

  test("setState puts an issue on the board and moves it to the column named after the state", async () => {
    graph = (q) => q.includes("projectV2(number") ? project : q.includes("addProjectV2ItemById") ? { addProjectV2ItemById: { item: { id: "IT" } } } : q.includes("issue(number") ? { repository: { issue: { ...gqlIssue(), projectItems: { nodes: [] } } } } : {};
    await t().setState("8", "needs_info");
    expect(calls.at(-1)!.body.variables).toEqual({ p: "P", i: "IT", f: "F", o: "o-info" });
    await expect(t().setState("8", "running")).rejects.toThrow(/no column for running/);
  });

  test("clearState clears the Status field of the issue's card, and does nothing when it has no card", async () => {
    let nodes: object[] = [{ id: "IT", project: { id: "P" }, fieldValueByName: { name: "Ready" } }];
    graph = (q) => q.includes("projectV2(number") ? project : q.includes("clearProjectV2ItemFieldValue") ? {} : { repository: { issue: { ...gqlIssue(), projectItems: { nodes } } } };
    await t().clearState("8");
    expect(calls.at(-1)!.body.query).toContain("clearProjectV2ItemFieldValue");
    expect(calls.at(-1)!.body.variables).toEqual({ p: "P", i: "IT", f: "F" });
    nodes = [];
    const n = calls.length;
    await t().clearState("8");
    expect(calls.slice(n).some((c) => String(c.body?.query).includes("clearProjectV2ItemFieldValue"))).toBe(false);
  });

  test("list keeps open issues of this repo in the column, oldest first", async () => {
    const card = (status: string, o: object) => ({ fieldValueByName: { name: status }, content: gqlIssue(o) });
    graph = (q) => q.includes("projectV2(number") ? project : q.includes("items(first") ? { node: { items: { pageInfo: { hasNextPage: false }, nodes: [
      card("Ready", { number: 9, createdAt: "2026-01-03" }), card("Ready", { number: 8 }), card("Needs info", { number: 7 }),
      card("Ready", { number: 6, state: "CLOSED" }), card("Ready", { number: 5, repository: { nameWithOwner: "acme/other" } }), { fieldValueByName: { name: "Ready" }, content: {} },
    ] } } } : { repository: { issue: { ...gqlIssue(), projectItems: { nodes: [{ id: "IT", project: { id: "P" }, fieldValueByName: { name: "Ready" } }] } } } };
    expect((await t().list("ready")).map((x) => [x.ref, x.state])).toEqual([["8", "ready"], ["9", "ready"]]);
    expect((await t().ticket("8")).state).toBe("ready");
  });

  test("startedBy is who made the last Status change on this board, when it moved the card to Ready", async () => {
    const change = (login: string, status: string, projectId = "P") => ({ actor: { login }, status, project: { id: projectId } });
    let nodes = [change("github-project-automation", "Backlog"), change("ann", "Ready"), change("bob", "Ready", "OTHER")];
    graph = (q) => q.includes("projectV2(number") ? project : { repository: { issue: { timelineItems: { nodes } } } };
    expect(await t().startedBy("8")).toBe("ann");
    nodes = [change("ann", "Ready"), change("github-project-automation", "In progress")];
    expect(await t().startedBy("8")).toBeUndefined();
  });
});

// The same request with and without a board: the state of an open work item is not read from a board here.
describe.each([["labels", undefined], ["board", 5]])("listOpen in %s mode", (_, projectNumber) => {
  const t = () => makeGitHubTracker(gh, REPO, projectNumber);
  const url = `GET /repos/${REPO}/issues?state=open&sort=created&direction=desc&per_page=100`;
  const page = (n: number, pulls = 0) => Array.from({ length: n }, (_, i) => (i < pulls ? issue({ number: 500 - i, pull_request: {} }) : issue({ number: 300 - i })));

  test("reads page by page, drops pull requests and returns at most the limit", async () => {
    rest[url] = page(100, 10);
    const l = await t().listOpen(150);
    expect(l).toHaveLength(150);
    expect(l.some((x) => Number(x.ref) > 400)).toBe(false);
    expect(calls.filter((c) => c.method === "GET" && c.path.startsWith(`/repos/${REPO}/issues`)).map((c) => c.path)).toEqual([
      `/repos/${REPO}/issues?state=open&sort=created&direction=desc&per_page=100&page=1`,
      `/repos/${REPO}/issues?state=open&sort=created&direction=desc&per_page=100&page=2`,
    ]);
    expect(calls.some((c) => c.method !== "GET" || c.path === "/graphql")).toBe(false);
  });

  test("stops after a page with fewer than 100 items", async () => {
    rest[url] = page(40);
    expect(await t().listOpen(150)).toHaveLength(40);
    expect(calls.filter((c) => c.path.includes("/issues?"))).toHaveLength(1);
  });
});
