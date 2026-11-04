import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test } from "vitest";
import { AI_LINE, GitLab } from "../gitlab";
import { makeGitLabTracker } from "./gitlab-tracker";

const PATH = "acme/web/react_frontend";
const load = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));

// One answer per URL path; everything else is 404. Calls are recorded.
let calls: { url: string; method: string; body?: any }[] = [];
let routes: Record<string, { body: unknown; headers?: Record<string, string> }> = {};
const fakeFetch = (async (url: string, init: RequestInit) => {
  const path = url.replace("https://gl.example/api/v4", "");
  calls.push({ url: path, method: init.method!, body: init.body ? JSON.parse(init.body as string) : undefined });
  const hit = routes[path.split("?")[0]];
  return new Response(JSON.stringify(hit?.body ?? {}), { status: hit ? 200 : 404, headers: hit?.headers });
}) as unknown as typeof fetch;
const last = () => calls[calls.length - 1];
const tracker = () => makeGitLabTracker(new GitLab("https://gl.example", "tok", fakeFetch), PATH);
const issue = (o: object = {}) => ({ iid: 8, title: "T", description: "D", state: "opened", labels: [], assignees: [], web_url: "u8", ...o });

beforeEach(() => {
  calls = [];
  routes = {
    [`/projects/${encodeURIComponent(PATH)}`]: { body: { id: 7, default_branch: "main" } },
    "/user": { body: { id: 1, username: "factory-bot" } },
    "/projects/7/issues/8": { body: {} },
    "/projects/7/issues/8/notes": { body: {} },
  };
});

describe("tickets", () => {
  test("a ticket maps state, mark, tags, assignees and open", async () => {
    routes["/projects/7/issues/8"] = { body: issue({ labels: ["factory_running", "factory_watcher", "bug"], assignees: [{ username: "ann" }], description: null }) };
    expect(await tracker().ticket("8")).toEqual({ ref: "8", title: "T", body: "", open: true, state: "running", marks: ["watcher"], tags: ["bug"], assignees: ["ann"], url: "u8" });
    routes["/projects/7/issues/8"] = { body: issue({ state: "closed" }) };
    expect(await tracker().ticket("8")).toMatchObject({ open: false, state: undefined, marks: [] });
  });
  // A person adds factory_ready again: an active run stays active, an ended run counts as ready.
  test("with two state labels, an active run wins over ready and ready wins over an ended run", async () => {
    const state = async (labels: string[]) => {
      routes["/projects/7/issues/8"] = { body: issue({ labels }) };
      return (await tracker().ticket("8")).state;
    };
    expect(await state(["factory_ready", "factory_needs_approval"])).toBe("needs_approval");
    expect(await state(["factory_waiting", "factory_ready"])).toBe("waiting");
    expect(await state(["factory_needs_info", "factory_ready"])).toBe("ready");
    expect(await state(["factory_done", "factory_ready"])).toBe("ready");
  });
  test("the project id is looked up once", async () => {
    routes["/projects/7/issues/8"] = { body: issue() };
    const t = tracker();
    await t.ticket("8");
    await t.ticket("8");
    expect(calls.filter((c) => c.url === `/projects/${encodeURIComponent(PATH)}`)).toHaveLength(1);
  });
  test("list reads open tickets of one state, oldest first", async () => {
    routes["/projects/7/issues"] = { body: [issue({ iid: 3, labels: ["factory_ready"] })] };
    expect((await tracker().list("ready")).map((t) => t.ref)).toEqual(["3"]);
    expect(last().url).toContain("labels=factory_ready&state=opened&order_by=created_at&sort=asc");
  });
  test("listClosed reads closed tickets, newest first, with no writes", async () => {
    routes["/projects/7/issues"] = { body: [issue({ iid: 5, state: "closed", description: null })] };
    expect(await tracker().listClosed(30)).toMatchObject([{ ref: "5", body: "", open: false }]);
    expect(last().method).toBe("GET");
    expect(last().url).toContain("state=closed&order_by=updated_at&sort=desc&per_page=30");
  });
  test("listOpen reads open tickets newest first, page by page, up to the limit", async () => {
    routes["/projects/7/issues"] = { body: Array.from({ length: 100 }, (_, i) => issue({ iid: 300 - i })) };
    const l = await tracker().listOpen(150);
    expect(l).toHaveLength(150);
    expect(calls.filter((c) => c.method === "GET" && c.url.includes("state=opened&order_by=created_at&sort=desc&per_page=100"))).toHaveLength(2);
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });
  test("setState puts one state label and removes the others", async () => {
    await tracker().setState("8", "running");
    expect(last()).toMatchObject({ method: "PUT", url: "/projects/7/issues/8", body: { add_labels: "factory_running", remove_labels: expect.stringContaining("factory_ready") } });
    expect(last().body.remove_labels).not.toContain("factory_running");
  });
  test("clearState removes every state label and adds none, so the marks stay", async () => {
    await tracker().clearState("8");
    expect(last()).toMatchObject({ method: "PUT", url: "/projects/7/issues/8" });
    expect(last().body.add_labels).toBeUndefined();
    expect(last().body.remove_labels.split(",")).toEqual(["factory_ready", "factory_running", "factory_needs_info", "factory_needs_approval", "factory_waiting", "factory_stopped", "factory_blocked", "factory_done"]);
    expect(last().body.remove_labels).not.toContain("factory_implemented");
  });
  test("mark adds its label and removes no other label", async () => {
    const t = tracker();
    await t.mark("8", "implemented");
    expect(last()).toMatchObject({ method: "PUT", url: "/projects/7/issues/8" });
    expect(last().body).toEqual({ add_labels: "factory_implemented" });
    await t.mark("8", "reviewed");
    expect(last().body).toEqual({ add_labels: "factory_reviewed" });
  });
  test("unmark removes its label and no other label", async () => {
    await tracker().unmark("8", "risk_high");
    expect(last()).toMatchObject({ method: "PUT", url: "/projects/7/issues/8" });
    expect(last().body).toEqual({ remove_labels: "factory_risk_high" });
  });
  // A person adds factory_ready to a blocked item: the event step continues the blocked run.
  test("ready next to an ended run's label reads as ready, and names the ended state", async () => {
    routes["/projects/7/issues/8"] = { body: issue({ labels: ["factory_blocked", "factory_ready"] }) };
    expect(await tracker().ticket("8")).toMatchObject({ state: "ready", ended: "blocked" });
    routes["/projects/7/issues/8"] = { body: issue({ labels: ["factory_ready"] }) };
    expect((await tracker().ticket("8")).ended).toBeUndefined();
  });
  test("close, reopen and assign", async () => {
    routes["/users"] = { body: [{ id: 4 }] };
    const t = tracker();
    await t.close("8");
    expect(last().body).toEqual({ state_event: "close" });
    await t.reopen("8");
    expect(last().body).toEqual({ state_event: "reopen" });
    await t.assign("8", "ann");
    expect(last().body).toEqual({ assignee_ids: [4] });
  });
});

describe("comments", () => {
  test("a comment starts with the AI line", async () => {
    await tracker().comment("8", "Triage done.");
    expect(last().url).toBe("/projects/7/issues/8/notes");
    expect(last().body.body.startsWith(AI_LINE)).toBe(true);
  });
  test("a comment holding a GitLab token is refused and not sent", async () => {
    const t = tracker();
    await t.ticket("8").catch(() => {}); // loads the project id
    calls = [];
    await expect(t.comment("8", "token glpat-abcdefghijklmnopqrst")).rejects.toThrow(/secret/);
    expect(calls).toHaveLength(0);
  });
  test("a /label line in a comment is escaped, so GitLab runs no quick action", async () => {
    await tracker().comment("8", "Questions:\n/label ~factory_ready\n/close");
    expect(last().body.body).not.toMatch(/^\s*\//m);
    expect(last().body.body).toContain("​/label ~factory_ready");
  });
  test("comments come newest first, skip system notes, and know the factory's own", async () => {
    routes["/projects/7/issues/8/notes"] = { body: [
      { author: { username: "factory-bot" }, body: "b", created_at: "2026-01-03T00:00:00Z" },
      { author: { username: "ann" }, body: "label changed", created_at: "2026-01-02T12:00:00Z", system: true },
      { author: { username: "ann" }, body: "a", created_at: "2026-01-02T00:00:00Z" },
    ] };
    const all = await tracker().comments("8");
    expect(all).toEqual([
      { author: "factory-bot", byFactory: true, body: "b", at: "2026-01-03T00:00:00Z" },
      { author: "ann", byFactory: false, body: "a", at: "2026-01-02T00:00:00Z" },
    ]);
    expect((await tracker().comments("8", "2026-01-02T00:00:00Z")).map((c) => c.body)).toEqual(["b"]);
  });
});

describe("people", () => {
  test("trusted needs access level 30 and is false for the factory", async () => {
    routes["/users"] = { body: [{ id: 5 }] };
    routes["/projects/7/members/all/5"] = { body: { access_level: 30 } };
    const t = tracker();
    expect(await t.trusted("ann")).toBe(true);
    routes["/projects/7/members/all/5"] = { body: { access_level: 20 } };
    expect(await t.trusted("ann")).toBe(false);
    delete routes["/projects/7/members/all/5"]; // 404: not a member
    expect(await t.trusted("ann")).toBe(false);
    calls = [];
    expect(await t.trusted("factory-bot")).toBe(false);
    expect(calls).toHaveLength(0);
    expect(await t.isFactory("factory-bot")).toBe(true);
    expect(await t.isFactory("ann")).toBe(false);
  });
  test("startedBy names who added the ready label last", async () => {
    routes["/projects/7/issues/8/resource_label_events"] = { body: [
      { action: "add", label: { name: "factory_ready" }, user: { id: 5 } },
      { action: "add", label: { name: "factory_ready" }, user: { id: 8 } },
    ] };
    routes["/users/8"] = { body: { username: "bob" } };
    expect(await tracker().startedBy("8")).toBe("bob");
    routes["/projects/7/issues/8/resource_label_events"] = { body: [] };
    expect(await tracker().startedBy("8")).toBeUndefined();
  });
});

describe("parseEvent", () => {
  test("a label just added gives ready, with the person's username", () => {
    expect(tracker().parseEvent(load("label-added.json"))).toEqual({ kind: "ready", ticket: "8", actor: "devone" });
  });
  test("a work_item event works too", () => {
    expect(tracker().parseEvent({ ...load("label-added.json"), object_kind: "work_item" })).toMatchObject({ kind: "ready" });
  });
  test("other edits and an old label are ignored", () => {
    expect(tracker().parseEvent(load("label-unchanged.json"))).toEqual({ kind: "ignored", reason: "not-added" });
    const p = load("label-added.json");
    p.changes.labels.previous = [{ title: "factory_ready" }];
    expect(tracker().parseEvent(p)).toEqual({ kind: "ignored", reason: "not-added" });
  });
  test("an approval of a factory change is ignored; a merge gives merged", () => {
    expect(tracker().parseEvent(load("mr-approved.json"))).toEqual({ kind: "ignored", reason: "not-added" });
    const p = load("mr-approved.json");
    p.object_attributes.action = "merge";
    expect(tracker().parseEvent(p)).toMatchObject({ kind: "merged", ticket: "8", change: "5" });
  });
  test("a change that is not a factory branch or not an approval is ignored", () => {
    const p = load("mr-approved.json");
    p.object_attributes.source_branch = "feature/x";
    expect(tracker().parseEvent(p)).toEqual({ kind: "ignored", reason: "not-added" });
    p.object_attributes = { ...load("mr-approved.json").object_attributes, action: "open" };
    expect(tracker().parseEvent(p)).toEqual({ kind: "ignored", reason: "not-added" });
  });
  test("a note with a command line gives a command, whatever the case", () => {
    expect(tracker().parseEvent(load("note-stop.json"))).toEqual({ kind: "command", ticket: "8", actor: "devone", command: "stop" });
    const p = load("note-stop.json");
    p.object_attributes.note = "  @Factory RESUME ";
    expect(tracker().parseEvent(p)).toEqual({ kind: "command", ticket: "8", actor: "devone", command: "resume" });
  });
  test("a system note and a plain comment are ignored; a command inside a longer line is a request", () => {
    const ignoredEvent = { kind: "ignored", reason: "not-added" };
    for (const edit of [(a: any) => (a.system = true), (a: any) => (a.note = "thanks, looks good")]) {
      const p = load("note-stop.json");
      edit(p.object_attributes);
      expect(tracker().parseEvent(p)).toEqual(ignoredEvent);
    }
    const p = load("note-stop.json");
    p.object_attributes.note = "do not @factory stop it";
    expect(tracker().parseEvent(p)).toEqual({ kind: "request", ticket: "8", actor: "devone" });
  });
  test("a note on a work item that asks @factory gives a request", () => {
    const p = load("note-stop.json");
    p.object_attributes.note = "@factory please add a test";
    expect(tracker().parseEvent(p)).toEqual({ kind: "request", ticket: "8", actor: "devone" });
  });
  const mrNote = (o: { branch?: string; target?: number; note?: string } = {}) => ({
    ...load("note-stop.json"),
    object_attributes: { id: 1245, note: o.note ?? "@factory rename the prop", noteable_type: "MergeRequest", system: false },
    issue: undefined,
    merge_request: { iid: 5, source_branch: o.branch ?? "factory/8-x", source_project_id: 7, target_project_id: o.target ?? 7 },
  });
  test("a note on a factory change gives a request with the change", () => {
    expect(tracker().parseEvent(mrNote())).toEqual({ kind: "request", ticket: "8", actor: "devone", change: "5" });
  });
  test("a note on a fork's change, a non-factory branch or a command line on a change is ignored", () => {
    for (const p of [mrNote({ target: 9 }), mrNote({ branch: "feature/x" }), mrNote({ note: "@factory stop" }), mrNote({ note: "nice" })]) {
      expect(tracker().parseEvent(p)).toEqual({ kind: "ignored", reason: "not-added" });
    }
  });
  test("another project is ignored", () => {
    for (const f of ["label-added.json", "mr-approved.json", "note-stop.json"]) {
      const p = load(f);
      p.project.path_with_namespace = "other/project";
      expect(tracker().parseEvent(p)).toEqual({ kind: "ignored", reason: "other-project" });
    }
  });
  test("a payload that is not an event is ignored", () => {
    expect(tracker().parseEvent(null)).toEqual({ kind: "ignored", reason: "not-added" });
    expect(tracker().parseEvent({ object_kind: "push" })).toEqual({ kind: "ignored", reason: "not-added" });
  });
});

describe("watcher tickets", () => {
  test("create labels the ticket, hides the fingerprint in the body and escapes quick actions", async () => {
    routes["/projects/7/issues"] = { body: { iid: 12, web_url: "u12" } };
    expect(await tracker().create({ title: "T", body: "Why.\n/close", state: "ready", marks: ["watcher"], fingerprint: "fp-1" })).toEqual({ ref: "12", url: "u12" });
    expect(last().method).toBe("POST");
    expect(last().body.labels).toBe("factory_watcher,factory_ready");
    expect(last().body.description).toContain("<!-- factory:fingerprint fp-1 -->");
    expect(last().body.description).not.toMatch(/^\s*\//m);
  });
  test("create refuses a body that holds a secret and sends nothing", async () => {
    const t = tracker();
    await t.ticket("8"); // loads the project id
    calls = [];
    await expect(t.create({ title: "T", body: "glpat-abcdefghijklmnopqrst", marks: [], fingerprint: "fp-3" })).rejects.toThrow(/secret/);
    expect(calls).toHaveLength(0);
  });
  test("findOpen searches open watcher tickets and checks the body", async () => {
    routes["/projects/7/issues"] = { body: [issue({ iid: 3, description: "other fp-12 text" }), issue({ iid: 4, description: "x\n<!-- factory:fingerprint fp-1 -->" })] };
    const t = tracker();
    expect(await t.findOpen("fp-1")).toBe("4");
    expect(last().url).toContain("labels=factory_watcher&state=opened&search=fp-1");
    expect(await t.findOpen("fp-2")).toBeUndefined();
  });
  test("createdSince counts watcher tickets made after the date", async () => {
    routes["/projects/7/issues"] = { body: [], headers: { "X-Total": "3" } };
    expect(await tracker().createdSince("watcher", new Date("2026-01-02T00:00:00Z"))).toBe(3);
    expect(last().url).toContain("labels=factory_watcher&created_after=2026-01-02T00%3A00%3A00.000Z");
  });
  // A missing count must not read as zero, or the daily cap never holds.
  test("createdSince fails when the count header is missing or not a number", async () => {
    for (const headers of [{}, { "X-Total": "" }, { "X-Total": "many" }] as Record<string, string>[]) {
      routes["/projects/7/issues"] = { body: [], headers };
      await expect(tracker().createdSince("watcher", new Date())).rejects.toThrow("X-Total");
    }
  });
});
