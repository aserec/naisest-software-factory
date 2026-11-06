import { beforeEach, describe, expect, test } from "vitest";
import { AI_LINE } from "../conversation";
import { GitHub } from "../github";
import { FACTORY_GIT_EMAIL } from "../repo";
import { makeGitHubCodeHost } from "./github-code-host";

const R = "/repos/o/app";
// One answer per "METHOD path" (or path for any method); everything else is 404. Calls are recorded.
let calls: { path: string; method: string; body?: any; accept?: string }[] = [];
let routes: Record<string, unknown>;
const fakeFetch = (async (url: string, init: RequestInit) => {
  const path = url.replace("https://api.github.com", "");
  const call = { path, method: init.method!, body: init.body ? JSON.parse(init.body as string) : undefined, accept: (init.headers as Record<string, string>).Accept };
  calls.push(call);
  const key = path.split("?")[0];
  const hit = routes[`${call.method} ${key}`] ?? routes[key];
  const body = typeof hit === "function" ? hit(call) : hit;
  return new Response(typeof body === "string" ? body : JSON.stringify(body ?? {}), { status: hit === undefined ? 404 : 200 });
}) as unknown as typeof fetch;
const host = () => makeGitHubCodeHost(new GitHub("tok", fakeFetch, async () => {}), "o/app", "tok", {}, "develop", async () => {});
const sent = (method: string, path: string) => calls.find((c) => c.method === method && c.path.split("?")[0] === path)?.body;
const withChecks = (runs: object[], statuses: object[] = []) => {
  routes[`${R}/pulls/5`] = { head: { sha: "h" } };
  routes[`${R}/commits/h/check-runs`] = { check_runs: runs };
  routes[`${R}/commits/h/status`] = { statuses };
};

beforeEach(() => {
  calls = [];
  routes = {};
});

describe("openChange", () => {
  test("opens a pull request into the base branch with the AI line, the closing line and no line that starts with a slash", async () => {
    routes[`GET ${R}/pulls`] = [];
    routes[`POST ${R}/pulls`] = { number: 5, html_url: "u5" };
    expect(await host().openChange("factory/8-x", "Add a spinner", "Text\n/merge", "8")).toEqual({ ref: "5", url: "u5" });
    const body = sent("POST", `${R}/pulls`);
    expect(body).toMatchObject({ head: "factory/8-x", base: "develop", title: "Add a spinner" });
    expect(body.body.startsWith([AI_LINE, "Closes #8"].join("\n\n"))).toBe(true);
    expect(body.body).not.toMatch(/^\s*\//m);
  });
  test("with no ticket the text has the AI line and no closing line", async () => {
    routes[`GET ${R}/pulls`] = [];
    routes[`POST ${R}/pulls`] = { number: 5, html_url: "u5" };
    await host().openChange("factory/weekly-1", "Weekly", "Report");
    expect(sent("POST", `${R}/pulls`).body).toBe([AI_LINE, "Report"].join("\n\n"));
  });
  test("a re-run reuses the open pull request of the branch and updates its text", async () => {
    routes[`GET ${R}/pulls`] = [{ number: 4, base: { ref: "develop" } }];
    routes[`PATCH ${R}/pulls/4`] = { number: 4, html_url: "u4" };
    expect(await host().openChange("factory/8-x", "t", "d", "8")).toEqual({ ref: "4", url: "u4" });
    expect(calls[0].path).toBe(`${R}/pulls?state=open&head=o%3Afactory%2F8-x`);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("change", () => {
  test("reads state, head, target and whether the base has commits the change lacks", async () => {
    routes[`${R}/pulls/5`] = { state: "open", merged: false, head: { sha: "h" }, base: { ref: "develop" }, html_url: "u", body: "B", merge_commit_sha: null };
    routes[`${R}/compare/develop...h`] = { behind_by: 2 };
    expect(await host().change("5")).toMatchObject({ open: true, merged: false, head: "h", target: "develop", body: "B", behind: true });
  });
});

describe("change", () => {
  test("gives the pull request's title", async () => {
    routes[`${R}/pulls/5`] = { title: "Add a spinner", state: "open", head: { sha: "h" }, base: { ref: "develop" }, html_url: "u" };
    routes[`${R}/compare/develop...h`] = { behind_by: 0 };
    expect((await host().change("5")).title).toBe("Add a spinner");
  });
  test("a pull request that GitHub cannot merge has conflicts; a mergeable state not computed yet does not", async () => {
    const p = { state: "open", head: { sha: "h" }, base: { ref: "develop" }, html_url: "u" };
    routes[`${R}/compare/develop...h`] = { behind_by: 0 };
    routes[`${R}/pulls/5`] = { ...p, mergeable: false, mergeable_state: "dirty" };
    expect((await host().change("5")).conflicts).toBe(true);
    routes[`${R}/pulls/5`] = { ...p, mergeable: null, mergeable_state: "unknown" };
    expect((await host().change("5")).conflicts).toBe(false);
    routes[`${R}/pulls/5`] = { ...p, mergeable: true, mergeable_state: "clean" };
    expect((await host().change("5")).conflicts).toBe(false);
  });
});

describe("checks", () => {
  test("a commit that is not the head is never green", async () => {
    withChecks([{ status: "completed", conclusion: "success" }]);
    expect(await host().checks({ change: "5", sha: "old" })).toBe("running");
  });
  test("all checks passed is green", async () => {
    withChecks([{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "skipped" }], [{ state: "success" }]);
    expect(await host().checks({ change: "5", sha: "h" })).toBe("green");
  });
  test("one failed check run or commit status is red", async () => {
    withChecks([{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "failure" }]);
    expect(await host().checks({ change: "5", sha: "h" })).toBe("red");
    withChecks([{ status: "completed", conclusion: "success" }], [{ state: "error" }]);
    expect(await host().checks({ change: "5", sha: "h" })).toBe("red");
  });
  test("no checks yet, or one still in progress, is running", async () => {
    withChecks([]);
    routes[`${R}/actions/workflows`] = { workflows: [{ state: "disabled_manually" }, { state: "active" }] };
    expect(await host().checks({ change: "5", sha: "h" })).toBe("running");
    withChecks([{ status: "in_progress", conclusion: null }]);
    expect(await host().checks({ branch: "develop", sha: "h" })).toBe("running");
  });
  test("no checks and no active workflow is absent at once; a workflow list it cannot read counts as active", async () => {
    withChecks([]);
    routes[`${R}/actions/workflows`] = { workflows: [{ state: "disabled_manually" }] };
    expect(await host().checks({ change: "5", sha: "h" })).toBe("absent");
    delete routes[`${R}/actions/workflows`];
    expect(await host().checks({ change: "5", sha: "h" })).toBe("running");
  });
  test("a canceled check gives no result on the base branch, and is red on a change", async () => {
    withChecks([{ status: "completed", conclusion: "cancelled" }]);
    expect(await host().checks({ branch: "develop", sha: "h" })).toBe("none");
    expect(await host().checks({ change: "5", sha: "h" })).toBe("red");
  });
});

test("merge squashes the reviewed head with the message and returns the landed commit", async () => {
  routes[`PUT ${R}/pulls/5/merge`] = { sha: "landed" };
  expect(await host().merge("5", "h", "[AM] feat: x\n\nbody")).toBe("landed");
  expect(sent("PUT", `${R}/pulls/5/merge`)).toEqual({ sha: "h", merge_method: "squash", commit_title: "[AM] feat: x", commit_message: "body" });
});

test("rebase updates the branch and returns its new head", async () => {
  let heads = ["h", "h", "h2"];
  routes[`GET ${R}/pulls/5`] = () => ({ head: { sha: heads.shift() } });
  routes[`PUT ${R}/pulls/5/update-branch`] = {};
  expect(await host().rebase("5")).toEqual({ ok: true, head: "h2" });
  expect(sent("PUT", `${R}/pulls/5/update-branch`)).toEqual({ expected_head_sha: "h" });
});

describe("readFile", () => {
  test("reads the raw file at the head of the base branch, with each path segment URL-encoded", async () => {
    routes[`${R}/contents/docs/my%20dir/CODEOWNERS`] = "* @alice\n";
    expect(await host().readFile("docs/my dir/CODEOWNERS")).toBe("* @alice\n");
    expect(calls[0]).toMatchObject({ method: "GET", path: `${R}/contents/docs/my%20dir/CODEOWNERS?ref=develop`, accept: "application/vnd.github.raw" });
  });
  test("a missing file is undefined, any other failure throws", async () => {
    expect(await host().readFile("CODEOWNERS")).toBeUndefined();
    const boom = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    const h = makeGitHubCodeHost(new GitHub("tok", boom, async () => {}), "o/app", "tok", {}, "develop", async () => {});
    await expect(h.readFile("CODEOWNERS")).rejects.toThrow(/500/);
  });
});

describe("changeOfTicket", () => {
  const pulls = (...o: object[]) => (routes[`GET ${R}/pulls`] = o.map((x) => ({ number: 1, state: "open", merged_at: null, head: { ref: "factory/12-x", repo: { full_name: "o/app" } }, created_at: "2026-01-01T00:00:00Z", html_url: "u", ...x })));
  test("lists pulls newest first and returns the newest of the ticket's branch, in any state", async () => {
    pulls({ number: 3, state: "closed", created_at: "2026-01-01T00:00:00Z" }, { number: 6, state: "closed", merged_at: "2026-01-04T00:00:00Z", created_at: "2026-01-03T00:00:00Z", html_url: "u6" }, { number: 4, created_at: "2026-01-02T00:00:00Z" });
    expect(await host().changeOfTicket("12")).toEqual({ ref: "6", open: false, merged: true, url: "u6" });
    expect(calls[0]).toMatchObject({ method: "GET", path: `${R}/pulls?state=all&sort=created&direction=desc&per_page=100` });
  });
  test("a branch of ticket 123 or a person's branch is not a change of ticket 12", async () => {
    pulls({ number: 9, head: { ref: "factory/123-x" } }, { number: 8, head: { ref: "feature/12-x" } });
    expect(await host().changeOfTicket("12")).toBeUndefined();
    pulls();
    expect(await host().changeOfTicket("12")).toBeUndefined();
  });
  test("a pull request from a fork with the same branch name is not a change of the ticket", async () => {
    pulls({ number: 9, head: { ref: "factory/12-x", repo: { full_name: "someone/app" } } }, { number: 8, head: { ref: "factory/12-x", repo: null } });
    expect(await host().changeOfTicket("12")).toBeUndefined();
  });
  test("an open pull request is open and not merged", async () => {
    pulls({ number: 4 });
    expect(await host().changeOfTicket("12")).toMatchObject({ ref: "4", open: true, merged: false });
  });
});

describe("branchDiff", () => {
  test("gives each file's patch against the base branch", async () => {
    routes[`${R}/compare/develop...s`] = { files: [{ filename: "a.ts", patch: "@@ -1 +1 @@\n-a\n+b", changes: 2 }, { filename: "i.png", changes: 0 }] };
    expect(await host().branchDiff("s")).toEqual({ "a.ts": "@@ -1 +1 @@\n-a\n+b", "i.png": "" });
  });
  test("throws when GitHub leaves out a changed file's patch", async () => {
    routes[`${R}/compare/develop...s`] = { files: [{ filename: "big.ts", changes: 5000 }] };
    await expect(host().branchDiff("s")).rejects.toThrow(/cut off/);
  });
});

describe("revert", () => {
  test("opens a pull request whose commit takes the tree of the merged commit's parent", async () => {
    routes[`${R}/git/ref/heads/develop`] = { object: { sha: "m" } };
    routes[`${R}/git/commits/m`] = { parents: [{ sha: "p" }] };
    routes[`${R}/git/commits/p`] = { tree: { sha: "tp" } };
    routes[`POST ${R}/git/commits`] = { sha: "rv" };
    routes[`POST ${R}/git/refs`] = {};
    routes[`POST ${R}/pulls`] = { number: 9, html_url: "u9" };
    expect(await host().revert("m")).toEqual({ ref: "9", url: "u9" });
    expect(sent("POST", `${R}/git/commits`)).toMatchObject({ tree: "tp", parents: ["m"] });
    expect(sent("POST", `${R}/git/refs`).sha).toBe("rv");
    expect(sent("POST", `${R}/pulls`)).toMatchObject({ base: "develop" });
  });
  test("refuses when the base branch moved past the commit", async () => {
    routes[`${R}/git/ref/heads/develop`] = { object: { sha: "newer" } };
    await expect(host().revert("m")).rejects.toThrow(/moved past/);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

test("a comment with a secret is refused", async () => {
  await expect(host().commentChange("5", "token glpat-abcdefghijklmnopqrst")).rejects.toThrow(/secret/);
  expect(calls).toHaveLength(0);
});

test("changeComments lists the comments created after since, newest first, and flags only the bot's own AI-line ones", async () => {
  routes["/user"] = { login: "bot" };
  routes[`${R}/pulls/5/comments`] = [];
  routes[`${R}/issues/5/comments`] = [
    { user: { login: "bob" }, body: "edited old", created_at: "2026-11-04T09:00:00Z" },
    { user: { login: "bot" }, body: `${AI_LINE}\n\ndone`, created_at: "2026-11-04T11:00:00Z" },
    { user: { login: "bot" }, body: "typed by a person on the shared account", created_at: "2026-11-04T11:30:00Z" },
    { user: { login: "ann" }, body: "@factory fix it", created_at: "2026-11-04T12:00:00Z" },
  ];
  expect(await host().changeComments("5", "2026-11-04T10:00:00Z")).toEqual([
    { author: "ann", byFactory: false, body: "@factory fix it", at: "2026-11-04T12:00:00Z" },
    { author: "bot", byFactory: false, body: "typed by a person on the shared account", at: "2026-11-04T11:30:00Z" },
    { author: "bot", byFactory: true, body: `${AI_LINE}\n\ndone`, at: "2026-11-04T11:00:00Z" },
  ]);
  expect(calls.find((c) => c.path.startsWith(`${R}/issues/5/comments`))!.path).toBe(`${R}/issues/5/comments?per_page=100&since=${encodeURIComponent("2026-11-04T10:00:00Z")}&page=1`);
});

test("changeComments compares times as times: a comment at the same second plus .500Z is after a since without milliseconds", async () => {
  routes["/user"] = { login: "bot" };
  routes[`${R}/pulls/5/comments`] = [];
  routes[`${R}/issues/5/comments`] = [
    { user: { login: "bob" }, body: "same", created_at: "2026-11-04T10:00:00Z" },
    { user: { login: "ann" }, body: "later", created_at: "2026-11-04T10:00:00.500Z" },
  ];
  expect((await host().changeComments("5", "2026-11-04T10:00:00Z")).map((c) => c.body)).toEqual(["later"]);
});

test("changeEdits reads body edits and title renames in one query, newest first, and flags the token user's", async () => {
  routes["/user"] = { login: "bot" };
  routes["/graphql"] = { data: { repository: { pullRequest: {
    userContentEdits: { nodes: [{ editor: { login: "bot" }, editedAt: "2026-11-04T10:00:00Z" }, { editor: null, editedAt: "2026-11-04T09:00:00Z" }] },
    timelineItems: { nodes: [{ actor: { login: "ann" }, createdAt: "2026-11-04T11:00:00Z" }] },
  } } } };
  expect(await host().changeEdits("5")).toEqual([
    { author: "ann", byFactory: false, field: "title", at: "2026-11-04T11:00:00Z" },
    { author: "bot", byFactory: true, field: "body", at: "2026-11-04T10:00:00Z" },
    { author: "ghost", byFactory: false, field: "body", at: "2026-11-04T09:00:00Z" },
  ]);
  const q = calls.find((c) => c.path === "/graphql")!.body;
  expect(q.query).toMatch(/userContentEdits/);
  expect(q.query).toMatch(/RENAMED_TITLE_EVENT/);
  expect(q.variables).toMatchObject({ owner: "o", name: "app", number: 5 });
});

test("changeEdits keeps only edits after since, and names a missing pull request", async () => {
  routes["/user"] = { login: "bot" };
  routes["/graphql"] = { data: { repository: { pullRequest: {
    userContentEdits: { nodes: [{ editor: { login: "ann" }, editedAt: "2026-11-04T10:00:00Z" }, { editor: { login: "ann" }, editedAt: "2026-11-01T09:00:00Z" }] },
    timelineItems: { nodes: [] },
  } } } };
  expect((await host().changeEdits("5", "2026-11-02T00:00:00Z")).map((e) => e.at)).toEqual(["2026-11-04T10:00:00Z"]);
  routes["/graphql"] = { data: { repository: { pullRequest: null } } };
  await expect(host().changeEdits("5")).rejects.toThrow("Pull request #5 not found in o/app");
});

test("changeCommits reads the pull request's commits and flags those with the factory's email", async () => {
  routes[`${R}/pulls/5/commits`] = [{ sha: "a1", commit: { author: { email: FACTORY_GIT_EMAIL } } }, { sha: "b2", commit: { author: { email: "ann@x.io" } } }];
  expect(await host().changeCommits("5")).toEqual([{ sha: "a1", byFactory: true }, { sha: "b2", byFactory: false }]);
  expect(calls[0].path).toBe(`${R}/pulls/5/commits?per_page=100&page=1`);
});

test("baseCommits reads the base branch's commits since a time; the title is the first line", async () => {
  routes[`${R}/commits`] = [{ sha: "c1", commit: { message: "Revert x\n\nbody", committer: { date: "2026-11-02T10:00:00Z" } } }];
  expect(await host().baseCommits("2026-11-01T00:00:00Z")).toEqual([{ sha: "c1", title: "Revert x", message: "Revert x\n\nbody", at: "2026-11-02T10:00:00Z" }]);
  expect(calls[0].path).toBe(`${R}/commits?sha=develop&since=2026-11-01T00%3A00%3A00Z&per_page=100&page=1`);
});
test("baseCommits reads every page and survives a commit with no committer", async () => {
  const commit = (i: number) => ({ sha: `s${i}`, commit: { message: "m", committer: { date: "2026-11-02T10:00:00Z" } } });
  routes[`${R}/commits`] = (c: { path: string }) => (c.path.endsWith("page=1") ? Array.from({ length: 100 }, (_, i) => commit(i)) : [{ sha: "x", commit: { message: "m", author: { date: "2026-11-02T09:00:00Z" } } }]);
  const all = await host().baseCommits("2026-11-01T00:00:00Z");
  expect(all).toHaveLength(101);
  expect(all.at(-1)).toMatchObject({ sha: "x", at: "2026-11-02T09:00:00Z" });
});

test("changeComments merges the inline review comments with the others by time, newest first, with the same since and byFactory rules", async () => {
  routes["/user"] = { login: "bot" };
  routes[`${R}/issues/5/comments`] = [
    { user: { login: "ann" }, body: "issue early", created_at: "2026-11-04T11:00:00Z" },
    { user: { login: "ann" }, body: "issue late", created_at: "2026-11-04T13:00:00Z" },
  ];
  routes[`${R}/pulls/5/comments`] = [
    { user: { login: "bob" }, body: "inline old", created_at: "2026-11-04T09:00:00Z" },
    { user: { login: "bot" }, body: `${AI_LINE}\n\ninline factory`, created_at: "2026-11-04T12:00:00Z" },
    { user: { login: "bot" }, body: "inline person", created_at: "2026-11-04T12:30:00Z" },
  ];
  expect((await host().changeComments("5", "2026-11-04T10:00:00Z")).map((c) => [c.body.split("\n").pop(), c.byFactory])).toEqual([
    ["issue late", false], ["inline person", false], ["inline factory", true], ["issue early", false],
  ]);
  const since = encodeURIComponent("2026-11-04T10:00:00Z");
  expect(calls.map((c) => c.path)).toContain(`${R}/pulls/5/comments?per_page=100&since=${since}&page=1`);
});

test("recentChanges makes one call and keeps the changes updated after since, from the factory's branches of this repo", async () => {
  const pull = (number: number, ref: string, updated_at: string, repo = "o/app") => ({ number, head: { ref, repo: { full_name: repo } }, updated_at });
  routes[`${R}/pulls`] = [
    pull(12, "factory/12-x", "2026-11-04T11:00:00Z"),
    pull(13, "factory/13-y", "2026-11-04T11:00:00Z", "fork/app"),
    pull(14, "feature/x", "2026-11-04T11:00:00Z"),
    pull(15, "factory/15-z", "2026-11-04T09:00:00Z"),
    pull(16, "factory/16-w", "2026-11-04T10:00:00.500Z", "O/App"),
  ];
  expect(await host().recentChanges("2026-11-04T10:00:00Z")).toEqual([{ ref: "12", ticket: "12" }, { ref: "16", ticket: "16" }]);
  expect(calls.map((c) => c.path)).toEqual([`${R}/pulls?state=open&sort=updated&direction=desc&per_page=100`]);
});

test("attach puts the image on its own branch, made from the base the first time", async () => {
  routes[`${R}/git/ref/heads/develop`] = { object: { sha: "b" } };
  routes[`POST ${R}/git/refs`] = {};
  routes[`PUT ${R}/contents/factory-assets/1-a.png`] = {};
  const now = Date.now;
  Date.now = () => 1;
  try {
    expect(await host().attach("a.png", Buffer.from("png"))).toBe("https://github.com/o/app/blob/factory-assets/factory-assets/1-a.png?raw=true");
  } finally {
    Date.now = now;
  }
  expect(sent("POST", `${R}/git/refs`)).toEqual({ ref: "refs/heads/factory-assets", sha: "b" });
  expect(sent("PUT", `${R}/contents/factory-assets/1-a.png`)).toMatchObject({ branch: "factory-assets", content: Buffer.from("png").toString("base64") });
});
