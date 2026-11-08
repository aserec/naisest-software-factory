import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "software-factory/run-events";
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { EVENTS_SQL, openDb } from "./db";

const at = (day: number, hour = 0) => new Date(Date.UTC(2026, 0, day, hour)).toISOString();
const ev = (type: RunEvent["type"], data: Record<string, unknown> = {}, o: Partial<RunEvent> = {}): RunEvent => ({
  id: randomUUID(),
  run: "r1",
  at: at(1),
  target: "react_frontend",
  ticket: "T-1",
  type,
  data,
  ...o,
}) as RunEvent;

describe("events", () => {
  it("reads with a cursor and ignores events it already has", () => {
    const db = openDb(":memory:");
    const [e1, e2, e3, e4] = [1, 2, 3, 4].map((n) => ev("step_start", { n }, { step: `s${n}` }));
    expect(db.addEvents([e1, e2, e3])).toBe(3);
    const first = db.events({ after: 0 });
    expect(first.events.map((e) => e.id)).toEqual([e1.id, e2.id, e3.id]);
    expect(first.cursor).toBe(3);
    expect(first.events[0]).toMatchObject({ ...e1, seq: 1 });
    expect(db.addEvents([e2, e4])).toBe(1);
    const next = db.events({ after: 3 });
    expect(next.events.map((e) => e.id)).toEqual([e4.id]);
    expect(next.cursor).toBe(4);
    expect(db.events({ after: 4 })).toEqual({ events: [], cursor: 4 });
  });

  it("filters by run and honours limit", () => {
    const db = openDb(":memory:");
    db.addEvents([ev("run_start"), ev("run_start", {}, { run: "r2" }), ev("run_end", { outcome: "done" })]);
    expect(db.events({ run: "r1" }).events).toHaveLength(2);
    const limited = db.events({ limit: 1 });
    expect(limited.events).toHaveLength(1);
    expect(limited.cursor).toBe(1);
  });
});

describe("indexes", () => {
  it("a run-filtered read uses the (run, seq) index", () => {
    const file = join(mkdtempSync(join(tmpdir(), "ix-")), "f.db");
    openDb(file);
    const plan = new DatabaseSync(file).prepare(`EXPLAIN QUERY PLAN ${EVENTS_SQL(true)}`).all(0, "r1", 10) as { detail: string }[];
    expect(plan.map((p) => p.detail).join(" ")).toContain("USING INDEX events_run");
  });
});

describe("switches", () => {
  it("defaults to on, a star scope turns a switch off for every target, and the change is logged", () => {
    const db = openDb(":memory:");
    expect(Object.values(db.switches("react_frontend")).every(Boolean)).toBe(true);
    db.setSwitch("*", "apply", false, "ana");
    const s = db.switches("react_frontend");
    expect(s.apply).toBe(false);
    expect(s.watcher).toBe(true);
    db.setSwitch("react_frontend", "watcher", false, "ana");
    db.setSwitch("*", "watcher", true, "ana");
    expect(db.switches("react_frontend").watcher).toBe(false);
    expect(db.switches("other").watcher).toBe(true);
    const logged = db.events({}).events.find((e) => e.type === "switch_change");
    expect(logged?.data).toEqual({ user: "ana", name: "apply", scope: "*", on: false });
  });
});

// The factory used to send label_change with the tracker's label name, factory_<state>. Stored rows keep it.
describe("run state", () => {
  it("reads an old factory_* label_change row and a new one as the same state", () => {
    const db = openDb(":memory:");
    db.addEvents([ev("label_change", { to: "factory_stopped" }, { run: "old" }), ev("label_change", { to: "stopped" }, { run: "new" })]);
    expect(db.view("old")?.state).toBe("stopped");
    expect(db.view("new")?.state).toBe("stopped");
    expect(db.view("old")?.actions).toEqual(db.view("new")?.actions);
  });
});

describe("requests", () => {
  const stopReq = { kind: "stop" as const, run: "r1", target: "react_frontend", ticket: "T-1", user: "ana" };

  it("refuses a second pending request of the same kind", () => {
    const db = openDb(":memory:");
    db.addEvents([ev("run_start"), ev("label_change", { to: "running" })]);
    const first = db.request(stopReq);
    expect(first).toMatchObject({ kind: "stop", run: "r1" });
    expect(db.request(stopReq)).toEqual({ refused: "already requested" });
    expect(db.requests({ pending: true })).toHaveLength(1);
  });

  // The rules live in run-view.ts; here only that request() asks the view and passes its reason on.
  it("refuses with the run view's reason, and accepts what the view allows", () => {
    const db = openDb(":memory:");
    db.addEvents([ev("run_start"), ev("label_change", { to: "running" })]);
    expect(db.request({ ...stopReq, kind: "resume" })).toEqual({ refused: "run is not stopped" });
    expect(db.request({ ...stopReq, kind: "restart" })).toEqual({ refused: "run is not stopped" });
    db.addEvents([ev("label_change", { to: "stopped" })]);
    expect(db.request({ ...stopReq, kind: "resume" })).toMatchObject({ kind: "resume" });
    expect(db.request({ ...stopReq, kind: "restart" })).toEqual({ refused: "a request is already waiting" });
    expect(db.requests({}).map((r) => r.kind)).toEqual(["resume"]);
    expect(db.request({ ...stopReq, run: "nope" })).toEqual({ refused: "run not found" });
  });

  // D-P4: a stop on a run that waits for approval used to be saved, and later set the work item to stopped.
  it("refuses a stop unless the run is running, and saves nothing", () => {
    const db = openDb(":memory:");
    db.addEvents([ev("run_start"), ev("label_change", { to: "factory_needs_approval" })]);
    expect(db.request(stopReq)).toEqual({ refused: "run is not running" });
    expect(db.requests({})).toEqual([]);
    expect(db.events({ run: "r1" }).events.some((e) => e.type === "stop")).toBe(false);
  });

  // R46: the view's `newer` comes from the run starts of the same work item.
  it("refuses resume and restart of a run that a newer run of the same work item overtook", () => {
    const db = openDb(":memory:");
    db.addEvents([ev("run_start"), ev("label_change", { to: "stopped" }), ev("run_start", {}, { run: "r0", ticket: "T-2" })]);
    db.finish((db.request({ ...stopReq, kind: "restart" }) as { id: string }).id, "refused");
    db.addEvents([ev("run_start", {}, { run: "r2" })]);
    expect(db.request({ ...stopReq, kind: "resume" })).toEqual({ refused: "run is not the ticket's newest run" });
  });

  it("a second restart is refused once the first is done, even after a pipeline cancel", () => {
    const db = openDb(":memory:");
    db.addEvents([ev("run_start"), ev("label_change", { to: "running" })]);
    db.finish((db.request(stopReq) as { id: string }).id, "cancelled");
    const restart = db.request({ ...stopReq, kind: "restart" }) as { id: string };
    db.finish(restart.id, "done");
    expect(db.request({ ...stopReq, kind: "restart" })).toEqual({ refused: "run already restarted" });
  });

  it("saves the audit event with the request, and neither when refused", () => {
    const db = openDb(":memory:");
    db.addEvents([ev("run_start"), ev("label_change", { to: "running" })]);
    const row = db.request(stopReq) as { at: string };
    expect(db.events({ run: "r1" }).events.at(-1)).toMatchObject({ type: "stop", at: row.at, data: { user: "ana" } });
    db.request(stopReq);
    expect(db.events({ run: "r1" }).events.filter((e) => e.type === "stop")).toHaveLength(1);
  });

  it("a stopped step_end finishes the pending stop request", () => {
    const db = openDb(":memory:");
    db.addEvents([ev("run_start"), ev("label_change", { to: "running" })]);
    db.request(stopReq);
    db.addEvents([ev("step_end", { outcome: "stopped" }, { step: "triage" })]);
    expect(db.requests({ pending: true })).toHaveLength(0);
    expect(db.requests({})[0]).toMatchObject({ outcome: "stopped" });
    expect(db.requests({})[0].doneAt).toBeTruthy();
  });

  it("cancelled keeps the request pending and survives a later finish", () => {
    const db = openDb(":memory:");
    db.addEvents([ev("run_start"), ev("label_change", { to: "running" })]);
    const r = db.request(stopReq) as { id: string };
    db.finish(r.id, "cancelled");
    expect(db.requests({ pending: true })[0]).toMatchObject({ id: r.id, outcome: "cancelled" });
    db.finish(r.id, "done");
    expect(db.requests({ pending: true })).toHaveLength(0);
    expect(db.requests({})[0].outcome).toBe("cancelled");
    expect(db.requests({})[0].doneAt).toBeTruthy();
  });

  it("filters by target and by age", () => {
    const db = openDb(":memory:");
    db.addEvents([ev("run_start"), ev("label_change", { to: "running" }), ev("run_start", {}, { run: "r2", target: "other" }), ev("label_change", { to: "running" }, { run: "r2", target: "other" })]);
    db.request(stopReq);
    db.request({ ...stopReq, run: "r2", target: "other" });
    expect(db.requests({ target: "other" })).toHaveLength(1);
    expect(db.requests({ sinceMinutes: 5 })).toHaveLength(2);
    expect(db.requests({ sinceMinutes: 0 })).toHaveLength(0);
  });
});

describe("runs", () => {
  it("summarises start, end, cost and the last step", () => {
    const db = openDb(":memory:");
    const usage = (costUsd: number) => ev("usage", { role: "dev", model: "m", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd, contextTokens: 1 });
    db.addEvents([
      ev("run_start", {}, { at: at(1) }),
      ev("step_start", {}, { step: "triage", at: at(1, 1) }),
      ev("step_end", { outcome: "next" }, { step: "triage" }),
      usage(0.25),
      ev("step_start", {}, { step: "prepare-patch", at: at(1, 2) }),
      usage(0.5),
      ev("run_start", {}, { run: "r2", target: "other", ticket: "T-2" }),
    ]);
    expect(db.runs({ ticket: "T-1" })).toEqual([
      { run: "r1", target: "react_frontend", ticket: "T-1", startedAt: at(1), costUsd: 0.75, lastStep: { step: "prepare-patch", startedAt: at(1, 2), ended: false } },
    ]);
    db.addEvents([ev("step_end", { outcome: "stop" }, { step: "prepare-patch" }), ev("run_end", { outcome: "done" }, { at: at(1, 3) })]);
    expect(db.runs({ target: "react_frontend" })[0]).toMatchObject({ endedAt: at(1, 3), outcome: "done", lastStep: { step: "prepare-patch", ended: true } });
    expect(db.runs({})).toHaveLength(2);
  });

  it("latestRuns gives only the newest run of each work item asked for", () => {
    const db = openDb(":memory:");
    db.addEvents([
      ev("run_start", {}, { run: "old", at: at(1) }),
      ev("run_start", {}, { run: "new", at: at(2) }),
      ev("step_start", {}, { run: "new", step: "triage", at: at(2, 1) }),
      ev("run_start", {}, { run: "r2", ticket: "T-2" }),
      ev("run_start", {}, { run: "r3", ticket: "T-3" }),
    ]);
    const runs = db.latestRuns([{ target: "react_frontend", ticket: "T-1" }, { target: "react_frontend", ticket: "T-2" }, { target: "react_frontend", ticket: "T-9" }]);
    expect(runs.map((r) => r.run).sort()).toEqual(["new", "r2"]);
    expect(runs.find((r) => r.run === "new")?.lastStep?.step).toBe("triage");
  });

  it("stateChanges gives every state set on the work items asked for, across runs, oldest first", () => {
    const db = openDb(":memory:");
    db.addEvents([
      ev("label_change", { to: "done" }, { run: "new", at: at(3) }),
      ev("label_change", { to: "factory_running" }, { run: "old", at: at(1) }),
      ev("label_change", { to: "stopped" }, { run: "old", at: at(2) }),
      ev("label_change", { to: "running" }, { run: "r2", ticket: "T-2" }),
    ]);
    expect(db.stateChanges([{ target: "react_frontend", ticket: "T-1" }]).map((c) => [c.run, c.at, c.state])).toEqual([
      ["old", at(1), "running"],
      ["old", at(2), "stopped"],
      ["new", at(3), "done"],
    ]);
  });

  it("itemEvents gives the work item's events of the types asked for, across runs, oldest first", () => {
    const db = openDb(":memory:");
    db.addEvents([
      ev("decision", { auto: false, reasons: [] }, { run: "new", at: at(3) }),
      ev("change_state", { conflicts: true }, { run: "old", at: at(1) }),
      ev("usage", { role: "a", model: "m", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 1, contextTokens: 1 }, { run: "old", at: at(2) }),
      ev("change_state", { conflicts: true }, { run: "r2", ticket: "T-2" }),
    ]);
    expect(db.itemEvents({ target: "react_frontend", ticket: "T-1" }, ["change_state", "decision"]).map((e) => [e.run, e.type])).toEqual([
      ["old", "change_state"],
      ["new", "decision"],
    ]);
  });

  it("newestPipeline gives the pipeline of the run's newest step_start", () => {
    const db = openDb(":memory:");
    expect(db.newestPipeline("r1")).toBeUndefined();
    db.addEvents([ev("step_start", {}, { step: "a", pipeline: "7" }), ev("step_end", { outcome: "next" }, { step: "a", pipeline: "8" }), ev("step_start", {}, { step: "b", pipeline: "9" })]);
    expect(db.newestPipeline("r1")).toBe("9");
  });

  it("keeps code review as the last step while a patch step inside it runs and ends", () => {
    const db = openDb(":memory:");
    db.addEvents([
      ev("run_start", {}, { at: at(1) }),
      ev("step_start", {}, { step: "code-review", at: at(1, 1) }),
      ev("step_start", { prompt: "fix it" }, { step: "patch", at: at(1, 2) }),
      ev("step_end", { outcome: "next" }, { step: "patch", at: at(1, 3) }),
    ]);
    expect(db.runs({ ticket: "T-1" })[0].lastStep).toEqual({ step: "code-review", startedAt: at(1, 1), ended: false });
  });

  it("keeps the highest review round and the decision's merge risk and merge request", () => {
    const db = openDb(":memory:");
    const finding = (round: number) => ev("review_finding", { text: "x", blocking: true, round });
    db.addEvents([
      ev("run_start", {}),
      finding(2),
      finding(1),
      ev("decision", { auto: false, reasons: ["r"], risk: 6, riskMax: 7, changeUrl: "http://gl/mr/9" }),
    ]);
    expect(db.runs({})[0]).toMatchObject({ round: 2, mergeRisk: 6, mergeRiskMax: 7, changeUrl: "http://gl/mr/9" });
  });

  it("marks a change with conflicts until a later decision: the round pushed a merge that passed the gate", () => {
    const db = openDb(":memory:");
    db.addEvents([ev("run_start", {}), ev("change_state", { conflicts: true })]);
    expect(db.runs({})[0].conflicts).toBe(true);
    expect(db.latestRuns([{ target: "react_frontend", ticket: "T-1" }])[0].conflicts).toBe(true);
    db.addEvents([ev("decision", { auto: false, reasons: ["r"] })]);
    expect(db.runs({})[0].conflicts).toBe(false);
  });
});

describe("prune and backup", () => {
  it("prune strips tool input and result after 90 days and leaves other events alone", () => {
    const db = openDb(":memory:");
    const call = { name: "bash", input: "ls", result: "secret", ms: 5, ok: true };
    const answer = { question: "q", answer: "a", confidence: "high" };
    db.addEvents([ev("tool_call", call), ev("jev_answer", answer)]);
    db.prune(new Date(Date.UTC(2026, 0, 1 + 89)));
    expect(db.events({}).events[0].data).toEqual(call);
    db.prune(new Date(Date.UTC(2026, 0, 1 + 91)));
    const [t, j] = db.events({}).events;
    expect(t.data).toEqual({ name: "bash", ms: 5, ok: true });
    expect(j.data).toEqual(answer);
  });

  it("backup writes a dated file and keeps the newest 7", () => {
    const dir = mkdtempSync(join(tmpdir(), "bk-"));
    const db = openDb(":memory:");
    db.addEvents([ev("run_start")]);
    for (let d = 1; d <= 8; d++) db.backup(dir, new Date(Date.UTC(2026, 0, d, 12)));
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(7);
    expect(files[0]).toBe("factory-2026-01-02.db");
    expect(existsSync(join(dir, "factory-2026-01-08.db"))).toBe(true);
    db.backup(dir, new Date(Date.UTC(2026, 0, 8, 18)));
    expect(readdirSync(dir)).toHaveLength(7);
    const copy = openDb(join(dir, "factory-2026-01-08.db"));
    expect(copy.events({}).events).toHaveLength(1);
  });

  it("backup leaves other files in the folder alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "bk-"));
    writeFileSync(join(dir, "notes.txt"), "x");
    const db = openDb(":memory:");
    for (let d = 1; d <= 9; d++) db.backup(dir, new Date(Date.UTC(2026, 0, d)));
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
  });
});

describe("dispatches", () => {
  it("keeps a dispatch pending for its target until it is done", () => {
    const db = openDb(":memory:");
    const a = db.addDispatch({ target: "react_frontend", source: "pip-audit", key: "requirements.txt", title: "vulnerable", details: "jinja2", link: "https://ci.example/1" });
    const b = db.addDispatch({ target: "react_frontend", source: "npm-audit", key: "package.json", title: "vulnerable", details: "" });
    db.addDispatch({ target: "other", source: "pip-audit", key: "k", title: "t", details: "" });
    expect(db.dispatches("react_frontend")).toEqual([a, b]);
    db.dispatchDone(a.id);
    expect(db.dispatches("react_frontend").map((s) => s.id)).toEqual([b.id]);
  });

  it("the log keeps done dispatches newest first, with when the run started and the work item it opened", () => {
    const db = openDb(":memory:");
    const d = (key: string) => db.addDispatch({ target: "react_frontend", source: "pip-audit", key, title: "t", details: "" });
    const [a, b, c] = [d("a"), d("b"), d("c")];
    db.addDispatch({ target: "other", source: "pip-audit", key: "k", title: "t", details: "" });
    db.dispatchStarted("react_frontend", at(2));
    db.dispatchDone(a.id, "https://gl/issues/7");
    db.dispatchDone(b.id);
    const log = db.dispatchLog("react_frontend", 10);
    expect(log.map((x) => x.key)).toEqual(["c", "b", "a"]);
    expect(log[2]).toMatchObject({ id: a.id, startedAt: at(2), workItem: "https://gl/issues/7" });
    expect(log[2].doneAt).toBeDefined();
    expect(log[1].doneAt).toBeDefined();
    expect(log[1].workItem).toBeUndefined();
    expect(log[0]).toMatchObject({ id: c.id, startedAt: at(2) });
    expect(log[0].doneAt).toBeUndefined();
    expect(db.dispatchLog("react_frontend", 1).map((x) => x.id)).toEqual([c.id]);
  });

  it("adds the work_item column to a database made before it", () => {
    const file = join(mkdtempSync(join(tmpdir(), "old-")), "f.db");
    new DatabaseSync(file).exec("CREATE TABLE dispatches (id TEXT PRIMARY KEY, target TEXT NOT NULL, source TEXT NOT NULL, key TEXT NOT NULL, title TEXT NOT NULL, details TEXT NOT NULL, link TEXT, at TEXT NOT NULL, started_at TEXT, done_at TEXT)");
    const db = openDb(file);
    const a = db.addDispatch({ target: "t", source: "s", key: "k", title: "t", details: "" });
    db.dispatchDone(a.id, "https://gl/issues/1");
    expect(db.dispatchLog("t", 1)[0].workItem).toBe("https://gl/issues/1");
    openDb(file); // a second open does not add it twice
  });
});

describe("switch changes", () => {
  it("lists who changed which switch, newest first, up to the limit", () => {
    const db = openDb(":memory:");
    db.setSwitch("*", "apply", false, "ana");
    db.setSwitch("demo", "watcher", false, "bo");
    db.setSwitch("demo", "watcher", true, "cy");
    db.addEvents([ev("run_start")]); // not a switch change
    expect(db.switchChanges(10).map(({ at, ...c }) => (expect(at).toBeTruthy(), c))).toEqual([
      { user: "cy", name: "watcher", scope: "demo", on: true },
      { user: "bo", name: "watcher", scope: "demo", on: false },
      { user: "ana", name: "apply", scope: "*", on: false },
    ]);
    expect(db.switchChanges(1).map((c) => c.user)).toEqual(["cy"]);
  });
});

describe("recent", () => {
  it("returns the asked types across targets, newest first, and stops at limit", () => {
    const db = openDb(":memory:");
    const [a, b, c] = [ev("run_end", { outcome: "done" }), ev("run_end", { outcome: "blocked" }, { target: "other" }), ev("run_end", { outcome: "done" })];
    db.addEvents([a, ev("usage"), b, c]);
    expect(db.recent({ types: ["run_end"], limit: 10 }).map((e) => e.id)).toEqual([c.id, b.id, a.id]);
    expect(db.recent({ types: ["run_end"], limit: 2 }).map((e) => e.id)).toEqual([c.id, b.id]);
  });
});

describe("latestLimits", () => {
  it("returns the newest usage event that carries limits", () => {
    const db = openDb(":memory:");
    expect(db.latestLimits()).toBeUndefined();
    const limits = (used: number) => ({ fiveHour: { used, resetsAt: at(5) }, sevenDay: { used: 0.1, resetsAt: at(9) } });
    db.addEvents([ev("usage", { limits: limits(0.2) }), ev("usage", { limits: limits(0.4) }, { at: at(2) }), ev("usage")]);
    expect(db.latestLimits()).toEqual({ at: at(2), limits: limits(0.4) });
  });
});

describe("history", () => {
  it("returns the asked target, types and times oldest first, and stops at limit", () => {
    const db = openDb(":memory:");
    const keep = [ev("decision", {}, { at: at(3) }), ev("run_start", {}, { at: at(2) }), ev("run_start", {}, { at: at(4) })];
    db.addEvents([ev("run_start", {}, { at: at(1) }), ...keep, ev("usage", {}, { at: at(3) }), ev("run_start", {}, { target: "other", at: at(3) })]);
    const q = { target: "react_frontend", since: at(2), types: ["run_start", "decision"] as RunEvent["type"][], limit: 10 };
    expect(db.history(q).map((e) => e.id)).toEqual(keep.map((e) => e.id));
    expect(db.history({ ...q, limit: 2 }).map((e) => e.id)).toEqual(keep.slice(0, 2).map((e) => e.id));
    expect(db.history({ ...q, types: [] })).toEqual([]);
  });
  it("compares times as times, so an event without milliseconds before since stays out", () => {
    const db = openDb(":memory:");
    const before = ev("run_start", {}, { at: "2026-06-01T10:00:00Z" });
    const after = ev("run_start", {}, { at: "2026-06-01T10:00:01Z" });
    db.addEvents([before, after]);
    expect(db.history({ target: "react_frontend", since: "2026-06-01T10:00:00.500Z", types: ["run_start"], limit: 10 }).map((e) => e.id)).toEqual([after.id]);
  });
});
