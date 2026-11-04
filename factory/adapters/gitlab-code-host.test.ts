import { beforeEach, describe, expect, test } from "vitest";
import { AI_LINE, GitLab } from "../gitlab";
import { FACTORY_GIT_EMAIL } from "../repo";
import { makeGitLabCodeHost } from "./gitlab-code-host";

const PATH = "acme/web/react_frontend";

// One answer per URL path; everything else is 404. Calls are recorded. A route can be a function of the call.
let calls: { url: string; method: string; body?: any }[] = [];
let routes: Record<string, unknown>;
const fakeFetch = (async (url: string, init: RequestInit) => {
  const path = url.replace("https://gl.example/api/v4", "");
  const call = { url: path, method: init.method!, body: init.body ? JSON.parse(init.body as string) : undefined };
  calls.push(call);
  const hit = routes[`${call.method} ${path.split("?")[0]}`] ?? routes[path.split("?")[0]];
  const body = typeof hit === "function" ? hit(call) : hit;
  return new Response(typeof body === "string" ? body : JSON.stringify(body ?? {}), { status: hit === undefined ? 404 : 200 });
}) as unknown as typeof fetch;
const last = () => calls[calls.length - 1];
// The real 5 s sleep would stall every rebase test.
let slept: number[] = [];
const host = () => makeGitLabCodeHost(new GitLab("https://gl.example", "tok", fakeFetch), PATH, "tok", {}, "develop", async (ms: number) => void slept.push(ms));
const mr = (o: object = {}) => ({ iid: 5, title: "T", state: "opened", target_branch: "develop", description: "D", sha: "h", merge_commit_sha: null, squash_commit_sha: null, web_url: "u5", ...o });
// A quick action runs from any line that starts with "/".
const quickAction = /^\s*\//m;

beforeEach(() => {
  calls = [];
  slept = [];
  routes = {
    [`/projects/${encodeURIComponent(PATH)}`]: { id: 7, default_branch: "master" },
    "/user": { id: 1, username: "factory-bot" },
  };
});

describe("branch and clone", () => {
  test("the base branch is the target's, not the project's default branch", async () => {
    expect(await host().baseBranch()).toBe("develop");
    expect(calls).toHaveLength(0);
  });
  test("the project is looked up once", async () => {
    routes["/projects/7/merge_requests/5/notes"] = {};
    const h = host();
    await h.commentChange("5", "a");
    await h.commentChange("5", "a");
    expect(calls.filter((c) => c.url === `/projects/${encodeURIComponent(PATH)}`)).toHaveLength(1);
  });
});

describe("openChange", () => {
  test("opens a change from the branch to the default branch with the AI line, the closing line and the text", async () => {
    routes["/projects/7/merge_requests"] = (c: any) => (c.method === "GET" ? [] : { iid: 5, web_url: "u5" });
    expect(await host().openChange("factory/8-x", "Add a spinner", "Factory run: u", "8")).toEqual({ ref: "5", url: "u5" });
    expect(last()).toMatchObject({ method: "POST", body: { source_branch: "factory/8-x", target_branch: "develop", title: "Add a spinner", description: [AI_LINE, "Closes #8", "Factory run: u"].join("\n\n") } });
  });
  test("with no ticket the text has the AI line and no closing line", async () => {
    routes["/projects/7/merge_requests"] = (c: any) => (c.method === "GET" ? [] : { iid: 5, web_url: "u5" });
    await host().openChange("factory/weekly-1", "Weekly", "Report");
    expect(last().body.description).toBe([AI_LINE, "Report"].join("\n\n"));
  });
  test("a re-run reuses the open change of the branch and updates its text", async () => {
    routes["/projects/7/merge_requests"] = [{ iid: 4, web_url: "u4", target_branch: "develop" }];
    routes["PUT /projects/7/merge_requests/4"] = {};
    expect(await host().openChange("factory/8-x", "t", "d", "8")).toEqual({ ref: "4", url: "u4" });
    expect(calls[1].url).toBe("/projects/7/merge_requests?state=opened&source_branch=factory%2F8-x");
    expect(last()).toMatchObject({ method: "PUT", url: "/projects/7/merge_requests/4", body: { title: "t", description: [AI_LINE, "Closes #8", "d"].join("\n\n") } });
  });
  test("an open change that targets another branch is refused", async () => {
    routes["/projects/7/merge_requests"] = [{ iid: 4, web_url: "u4", target_branch: "master" }];
    await expect(host().openChange("factory/8-x", "t", "d", "8")).rejects.toThrow(/master/);
  });
  test("a line that starts with a slash reaches the change text escaped, on open and on update", async () => {
    const text = "Changed tests, and why:\n\n/merge\n  /approve";
    routes["/projects/7/merge_requests"] = (c: any) => (c.method === "GET" ? [] : { iid: 5, web_url: "u5" });
    await host().openChange("factory/8-x", "t", text, "8");
    expect(last().body.description).not.toMatch(quickAction);
    expect(last().body.description).toContain("​/merge");
    routes["/projects/7/merge_requests"] = [{ iid: 4, web_url: "u4", target_branch: "develop" }];
    routes["PUT /projects/7/merge_requests/4"] = {};
    await host().openChange("factory/8-x", "t", text, "8");
    expect(last().method).toBe("PUT");
    expect(last().body.description).not.toMatch(quickAction);
  });
});

describe("change", () => {
  test("maps state, head, landed commit, url and body", async () => {
    routes["/projects/7/merge_requests/5"] = mr({ description: null });
    expect(await host().change("5")).toEqual({ ref: "5", open: true, merged: false, head: "h", landedSha: "h", url: "u5", title: "T", body: "", target: "develop", behind: false });
    routes["/projects/7/merge_requests/5"] = mr({ state: "merged", merge_commit_sha: "m" });
    expect(await host().change("5")).toMatchObject({ open: false, merged: true, landedSha: "m" });
    routes["/projects/7/merge_requests/5"] = mr({ state: "closed", squash_commit_sha: "sq" });
    expect(await host().change("5")).toMatchObject({ open: false, merged: false, landedSha: "sq" });
  });
  test("gives the merge request's title", async () => {
    routes["/projects/7/merge_requests/5"] = mr({ title: "Add a spinner" });
    expect((await host().change("5")).title).toBe("Add a spinner");
  });
  test("asks for the diverged count: a branch with target commits it lacks is behind", async () => {
    routes["/projects/7/merge_requests/5"] = mr({ diverged_commits_count: 0 });
    expect((await host().change("5")).behind).toBe(false);
    expect(calls.at(-1)!.url).toBe("/projects/7/merge_requests/5?include_diverged_commits_count=true");
    routes["/projects/7/merge_requests/5"] = mr({ diverged_commits_count: 2 });
    expect((await host().change("5")).behind).toBe(true);
  });
});

describe("rebase", () => {
  const POLL = "/projects/7/merge_requests/5?include_rebase_in_progress=true";
  // The change answers in order, and keeps the last answer.
  const answers = (...a: object[]) => (routes["GET /projects/7/merge_requests/5"] = () => (a.length > 1 ? a.shift() : a[0]));
  test("asks GitLab to rebase, waits while it runs, and returns the new head", async () => {
    routes["PUT /projects/7/merge_requests/5/rebase"] = { rebase_in_progress: true };
    answers({ sha: "h" }, { rebase_in_progress: true }, { rebase_in_progress: true }, { rebase_in_progress: false, sha: "h2", merge_error: null });
    expect(await host().rebase("5")).toEqual({ ok: true, head: "h2" });
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.url)).toEqual(["/projects/7/merge_requests/5/rebase"]);
    const reads = calls.filter((c) => c.method === "GET" && c.url.startsWith("/projects/7/merge_requests/5"));
    expect(reads.map((c) => c.url)).toEqual(["/projects/7/merge_requests/5", POLL, POLL, POLL]); // the head before the rebase, then the polls
    expect(slept).toEqual([5000, 5000, 5000]);
  });
  test("a rebase that has ended waits until the change shows the new head", async () => {
    routes["PUT /projects/7/merge_requests/5/rebase"] = { rebase_in_progress: true };
    answers({ sha: "h" }, { rebase_in_progress: false, sha: "h", merge_error: null }, { rebase_in_progress: false, sha: "h", merge_error: null }, { rebase_in_progress: false, sha: "h2", merge_error: null });
    expect(await host().rebase("5")).toEqual({ ok: true, head: "h2" });
    expect(slept).toEqual([5000, 5000, 5000]);
  });
  test("a rebase that ends with a merge error fails with that error", async () => {
    routes["PUT /projects/7/merge_requests/5/rebase"] = { rebase_in_progress: true };
    answers({ sha: "h" }, { rebase_in_progress: false, sha: "h", merge_error: "Rebase failed: conflict in src/a.ts" });
    expect(await host().rebase("5")).toEqual({ ok: false, error: "Rebase failed: conflict in src/a.ts" });
  });
  test("a rebase GitLab refuses fails, and so does one still running after 60 polls", async () => {
    answers({ rebase_in_progress: false, sha: "h2", merge_error: null });
    expect(await host().rebase("5")).toEqual({ ok: false, error: expect.stringMatching(/status 404/) });
    expect(slept).toEqual([]);
    routes["PUT /projects/7/merge_requests/5/rebase"] = { rebase_in_progress: true };
    answers({ rebase_in_progress: true });
    expect(await host().rebase("5")).toEqual({ ok: false, error: "the rebase did not end within 5 minutes" });
    expect(slept).toEqual(Array(60).fill(5000));
  });
});

describe("branchDiff", () => {
  test("returns each file's diff against the base branch from their merge base", async () => {
    routes["/projects/7/repository/compare"] = { diffs: [{ old_path: "src/a.ts", new_path: "src/b.ts", diff: "@@ -1 +1 @@\n-a\n+b\n" }] };
    expect(await host().branchDiff("abc")).toEqual({ "src/b.ts": "@@ -1 +1 @@\n-a\n+b\n" });
    expect(last().url).toBe("/projects/7/repository/compare?from=develop&to=abc");
  });
  test("a cut-off diff fails instead of reading as no change", async () => {
    for (const cut of [{ compare_timeout: true, diffs: [] }, { diffs: [{ new_path: "a", diff: "", too_large: true }] }, { diffs: [{ new_path: "a", diff: "", collapsed: true }] }]) {
      routes["/projects/7/repository/compare"] = cut;
      await expect(host().branchDiff("abc")).rejects.toThrow(/cut off/);
    }
  });
});

describe("readFile", () => {
  test("reads the raw file at the head of the base branch, with the path URL-encoded", async () => {
    routes["/projects/7/repository/files/docs%2FCODEOWNERS/raw"] = "* @alice\n";
    expect(await host().readFile("docs/CODEOWNERS")).toBe("* @alice\n");
    expect(last()).toMatchObject({ method: "GET", url: "/projects/7/repository/files/docs%2FCODEOWNERS/raw?ref=develop" });
  });
  test("a missing file is undefined, any other failure throws", async () => {
    expect(await host().readFile("CODEOWNERS")).toBeUndefined();
    // The project lookup works; only the file read fails, so the 500 must come from fileRaw.
    const boom = (async (url: string) => (url.endsWith("/raw?ref=develop") ? new Response("", { status: 500 }) : fakeFetch(url, { method: "GET" }))) as unknown as typeof fetch;
    const h = makeGitLabCodeHost(new GitLab("https://gl.example", "tok", boom), PATH, "tok", {}, "develop");
    await expect(h.readFile("CODEOWNERS")).rejects.toThrow(/500/);
  });
});

describe("changeOfTicket", () => {
  const related = (...o: object[]) => (routes["/projects/7/issues/12/related_merge_requests"] = o.map((x) => ({ iid: 1, state: "opened", source_branch: "factory/12-x", source_project_id: 7, created_at: "2026-01-01T00:00:00Z", web_url: "u", ...x })));
  test("reads the merge requests that close the issue and returns the newest of its branch, in any state", async () => {
    related({ iid: 3, state: "closed", created_at: "2026-01-01T00:00:00Z" }, { iid: 6, state: "merged", created_at: "2026-01-03T00:00:00Z", web_url: "u6" }, { iid: 4, created_at: "2026-01-02T00:00:00Z" });
    expect(await host().changeOfTicket("12")).toEqual({ ref: "6", open: false, merged: true, url: "u6" });
    expect(last()).toMatchObject({ method: "GET", url: "/projects/7/issues/12/related_merge_requests?per_page=100" });
  });
  test("a branch of ticket 123 or a person's branch is not a change of ticket 12", async () => {
    related({ iid: 9, source_branch: "factory/123-x" }, { iid: 8, source_branch: "feature/12-x" });
    expect(await host().changeOfTicket("12")).toBeUndefined();
    related();
    expect(await host().changeOfTicket("12")).toBeUndefined();
  });
  test("a merge request from a fork with the same branch name is not a change of the ticket", async () => {
    related({ iid: 9, source_project_id: 99 });
    expect(await host().changeOfTicket("12")).toBeUndefined();
  });
  test("an open merge request is open and not merged", async () => {
    related({ iid: 4 });
    expect(await host().changeOfTicket("12")).toMatchObject({ ref: "4", open: true, merged: false });
  });
  test("a locked merge request (a merge in flight) is open, not closed", async () => {
    related({ iid: 4, state: "locked" });
    expect(await host().changeOfTicket("12")).toMatchObject({ ref: "4", open: true, merged: false });
  });
});

describe("checks", () => {
  test("a change reads the newest pipeline of its head: canceled is red, none is running", async () => {
    const at = { change: "5", sha: "h" };
    const pipelines = (...p: object[]) => (routes["/projects/7/merge_requests/5/pipelines"] = p);
    pipelines({ status: "success", sha: "h" }, { status: "failed", sha: "h" });
    expect(await host().checks(at)).toBe("green");
    pipelines({ status: "canceled", sha: "h" }, { status: "success", sha: "h" });
    expect(await host().checks(at)).toBe("red");
    pipelines({ status: "failed", sha: "h" });
    expect(await host().checks(at)).toBe("red");
    pipelines({ status: "pending", sha: "h" });
    expect(await host().checks(at)).toBe("running");
    pipelines();
    expect(await host().checks(at)).toBe("running");
  });
  test("a green pipeline of an older commit says nothing about the head", async () => {
    routes["/projects/7/merge_requests/5/pipelines"] = [{ status: "success", sha: "older" }];
    expect(await host().checks({ change: "5", sha: "head" })).toBe("running");
    routes["/projects/7/merge_requests/5/pipelines"] = [{ status: "failed", sha: "older" }];
    expect(await host().checks({ change: "5", sha: "head" })).toBe("running");
  });
  test("a branch maps success, failed and anything else; canceled and skipped will never give a result", async () => {
    const at = { branch: "master", sha: "abc" };
    const status = (s?: string) => (routes["/projects/7/pipelines"] = s ? [{ status: s }] : []);
    status("success");
    expect(await host().checks(at)).toBe("green");
    expect(last().url).toBe("/projects/7/pipelines?ref=master&sha=abc&per_page=1");
    status("failed");
    expect(await host().checks(at)).toBe("red");
    status("pending");
    expect(await host().checks(at)).toBe("running");
    status();
    expect(await host().checks(at)).toBe("running");
    status("canceled");
    expect(await host().checks(at)).toBe("none");
    status("skipped");
    expect(await host().checks(at)).toBe("none");
  });
});

describe("merge, revert, comment, assign", () => {
  test("merge sends the reviewed head and returns the commit that landed", async () => {
    routes["PUT /projects/7/merge_requests/5/merge"] = { merge_commit_sha: null, squash_commit_sha: "sq1", sha: "head" };
    expect(await host().merge("5", "head", "[AM] m")).toBe("sq1");
    expect(last()).toMatchObject({ method: "PUT", url: "/projects/7/merge_requests/5/merge", body: { sha: "head", squash: true, squash_commit_message: "[AM] m" } });
    routes["PUT /projects/7/merge_requests/5/merge"] = { merge_commit_sha: "m1", sha: "head" };
    expect(await host().merge("5", "head", "[AM] m")).toBe("m1");
  });
  test("revert opens a change from a new branch off the base branch", async () => {
    routes["/projects/7/repository/branches"] = {};
    routes["/projects/7/repository/commits/abcdef1234/revert"] = {};
    routes["/projects/7/merge_requests"] = { iid: 9, web_url: "u9" };
    expect(await host().revert("abcdef1234")).toEqual({ ref: "9", url: "u9" });
    const [, branch, revert, opened] = calls;
    expect(branch).toMatchObject({ url: "/projects/7/repository/branches", body: { branch: expect.stringMatching(/^factory\/revert-abcdef12-\d+$/), ref: "develop" } });
    expect(revert.body).toEqual({ branch: branch.body.branch });
    expect(opened.body).toMatchObject({ source_branch: branch.body.branch, target_branch: "develop" });
  });
  test("a comment starts with the AI line, escapes slash lines and refuses secrets", async () => {
    routes["/projects/7/merge_requests/5/notes"] = {};
    await host().commentChange("5", "Reasons\n/merge");
    expect(last().url).toBe("/projects/7/merge_requests/5/notes");
    expect(last().body.body.startsWith(AI_LINE)).toBe(true);
    expect(last().body.body).not.toMatch(quickAction);
    const before = calls.length;
    await expect(host().commentChange("5", "glpat-abcdefghijklmnopqrst")).rejects.toThrow(/secret/);
    expect(calls.slice(before).filter((c) => c.method === "POST")).toHaveLength(0);
  });
  test("changeComments lists the people's and the factory's notes after since, newest first, and flags the factory's", async () => {
    routes["/projects/7/merge_requests/5/notes"] = [
      { system: false, author: { username: "ann" }, body: "@factory fix it", created_at: "2026-11-04T12:00:00Z" },
      { system: true, author: { username: "ann" }, body: "added 1 commit", created_at: "2026-11-04T11:30:00Z" },
      { system: false, author: { username: "factory-bot" }, body: "done", created_at: "2026-11-04T11:00:00Z" },
      { system: false, author: { username: "bob" }, body: "old", created_at: "2026-11-04T09:00:00Z" },
    ];
    expect(await host().changeComments("5", "2026-11-04T10:00:00Z")).toEqual([
      { author: "ann", byFactory: false, body: "@factory fix it", at: "2026-11-04T12:00:00Z" },
      { author: "factory-bot", byFactory: true, body: "done", at: "2026-11-04T11:00:00Z" },
    ]);
    expect(last().url).toBe("/projects/7/merge_requests/5/notes?sort=desc&order_by=created_at&per_page=100");
  });
  test("changeComments compares times as times: a note at the same second plus .500Z is after a since without milliseconds", async () => {
    routes["/projects/7/merge_requests/5/notes"] = [
      { system: false, author: { username: "ann" }, body: "later", created_at: "2026-11-04T10:00:00.500Z" },
      { system: false, author: { username: "bob" }, body: "same", created_at: "2026-11-04T10:00:00.000Z" },
    ];
    expect((await host().changeComments("5", "2026-11-04T10:00:00Z")).map((c) => c.body)).toEqual(["later"]);
  });
  test("changeEdits keeps only the system notes about the title and the description, and flags the bot's", async () => {
    routes["/projects/7/merge_requests/5/notes"] = [
      { system: true, author: { username: "ann" }, body: "changed title from **A** to **B**", created_at: "2026-11-04T12:00:00Z" },
      { system: true, author: { username: "ann" }, body: "added 1 commit", created_at: "2026-11-04T11:50:00Z" },
      { system: false, author: { username: "ann" }, body: "changed title in a comment", created_at: "2026-11-04T11:40:00Z" },
      { system: true, author: { username: "factory-bot" }, body: "changed the description", created_at: "2026-11-04T11:00:00Z" },
    ];
    expect(await host().changeEdits("5")).toEqual([
      { author: "ann", byFactory: false, field: "title", at: "2026-11-04T12:00:00Z" },
      { author: "factory-bot", byFactory: true, field: "body", at: "2026-11-04T11:00:00Z" },
    ]);
    expect((await host().changeEdits("5", "2026-11-04T11:30:00Z")).map((e) => e.field)).toEqual(["title"]);
    expect(last().url).toBe("/projects/7/merge_requests/5/notes?sort=desc&order_by=created_at&per_page=100");
  });
  test("changeCommits reads the change's commits and flags those with the factory's email", async () => {
    routes["/projects/7/merge_requests/5/commits"] = [{ id: "a1", author_email: FACTORY_GIT_EMAIL }, { id: "b2", author_email: "ann@x.io" }];
    expect(await host().changeCommits("5")).toEqual([{ sha: "a1", byFactory: true }, { sha: "b2", byFactory: false }]);
    expect(last().url).toBe("/projects/7/merge_requests/5/commits?per_page=100&page=1");
  });
  test("baseCommits reads the base branch's commits since a time", async () => {
    routes["/projects/7/repository/commits"] = [{ id: "c1", title: "Revert x", message: "Revert x\n\nbody", committed_date: "2026-11-02T10:00:00Z", author_name: "ann" }];
    expect(await host().baseCommits("2026-11-01T00:00:00Z")).toEqual([{ sha: "c1", title: "Revert x", message: "Revert x\n\nbody", at: "2026-11-02T10:00:00Z" }]);
    expect(last().url).toBe("/projects/7/repository/commits?ref_name=develop&since=2026-11-01T00%3A00%3A00Z&per_page=100&page=1");
  });
  test("recentChanges makes one call and keeps the open changes of the factory's branches from this project", async () => {
    routes["/projects/7/merge_requests"] = [
      { iid: 12, source_branch: "factory/12-x", source_project_id: 7 },
      { iid: 13, source_branch: "factory/13-y", source_project_id: 99 },
      { iid: 14, source_branch: "feature/x", source_project_id: 7 },
    ];
    const since = "2026-11-04T10:00:00Z";
    expect(await host().recentChanges(since)).toEqual([{ ref: "12", ticket: "12" }]);
    const listing = calls.filter((c) => c.url.startsWith("/projects/7/merge_requests"));
    expect(listing.map((c) => c.url)).toEqual([`/projects/7/merge_requests?state=opened&updated_after=${encodeURIComponent(since)}&order_by=updated_at&sort=desc&per_page=100`]);
  });
  test("assign looks up the user and puts the id on the change", async () => {
    routes["/users"] = [{ id: 12 }];
    routes["PUT /projects/7/merge_requests/5"] = {};
    await host().assignChange("5", "ann");
    expect(calls.find((c) => c.url.startsWith("/users"))!.url).toBe("/users?username=ann");
    expect(last()).toMatchObject({ method: "PUT", url: "/projects/7/merge_requests/5", body: { assignee_ids: [12] } });
  });
  test("close puts the close state event on the change", async () => {
    routes["PUT /projects/7/merge_requests/5"] = {};
    await host().closeChange("5");
    expect(last()).toMatchObject({ method: "PUT", url: "/projects/7/merge_requests/5", body: { state_event: "close" } });
  });
});

describe("attach", () => {
  const upload = (status = 200) => {
    const seen: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ url: "/uploads/abc/after-a.png" }), { status });
    }) as unknown as typeof fetch;
    return { seen, host: makeGitLabCodeHost(new GitLab("https://gl.example", "tok", async (u, i) => (u.toString().endsWith(`/projects/${encodeURIComponent(PATH)}`) ? new Response(JSON.stringify({ id: 7, default_branch: "master" })) : f(u, i!))), PATH, "tok", {}, "develop") };
  };
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  test("posts the file to the project's uploads and returns the url", async () => {
    const { seen, host } = upload();
    expect(await host.attach("after-a.png", PNG)).toBe("/uploads/abc/after-a.png");
    const { url, init } = seen[0];
    expect(url).toBe("https://gl.example/api/v4/projects/7/uploads");
    expect(init.method).toBe("POST");
    const file = (init.body as FormData).get("file") as File;
    expect(file.name).toBe("after-a.png");
    expect(file.type).toBe("image/png");
    expect(Buffer.from(await file.arrayBuffer())).toEqual(PNG);
    expect(init.headers).toEqual({ "PRIVATE-TOKEN": "tok" }); // fetch sets the multipart type
  });
  test("a 500 rejects and the message holds no token", async () => {
    const e = await upload(500).host.attach("after-a.png", PNG).catch((x) => x);
    expect(e.message).toBe("GitLab POST /projects/7/uploads failed with status 500");
    expect(e.message).not.toContain("tok");
  });
});
