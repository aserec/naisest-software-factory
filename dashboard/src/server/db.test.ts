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
});

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

describe("requests", () => {
  const stopReq = { kind: "stop" as const, run: "r1", target: "react_frontend", ticket: "T-1", user: "ana" };

  it("refuses a second pending request of the same kind", () => {
    const db = openDb(":memory:");
    db.addEvents([ev("run_start")]);
    const first = db.request(stopReq);
    expect(first).toMatchObject({ kind: "stop", run: "r1" });
    expect(db.request(stopReq)).toEqual({ refused: "already requested" });
    expect(db.requests({ pending: true })).toHaveLength(1);
  });

  it("refuses stop after run_end, and resume or restart unless the last step stopped", () => {
    const db = openDb(":memory:");
    db.addEvents([ev("run_start"), ev("step_start", {}, { step: "triage" }), ev("step_end", { outcome: "next" }, { step: "triage" })]);
    expect(db.request({ ...stopReq, kind: "restart" })).toEqual({ refused: "run is not stopped" });
    expect(db.request({ ...stopReq, kind: "resume" })).toEqual({ refused: "run is not stopped" });
    db.addEvents([ev("step_end", { outcome: "stopped" }, { step: "triage" })]);
    expect(db.request({ ...stopReq, kind: "resume" })).toMatchObject({ kind: "resume" });
    db.addEvents([ev("run_end", { outcome: "done" })]);
    expect(db.request(stopReq)).toEqual({ refused: "run already ended" });
  });

  it("refuses resume and restart once the run has a run_end, even after a stop", () => {
    const db = openDb(":memory:");
    db.addEvents([ev("run_start"), ev("step_end", { outcome: "stopped" }, { step: "triage" }), ev("run_end", { outcome: "restarted" })]);
    expect(db.request({ ...stopReq, kind: "resume" })).toEqual({ refused: "run already ended" });
    expect(db.request({ ...stopReq, kind: "restart" })).toEqual({ refused: "run already ended" });
  });

  // R46: a request acts on the ticket, so it must be for the ticket's newest run.
  it("refuses resume and restart of a run that a newer run of the same ticket overtook", () => {
    const db = openDb(":memory:");
    db.addEvents([ev("run_start"), ev("step_end", { outcome: "stopped" }, { step: "triage" }), ev("run_start", {}, { run: "r0", ticket: "T-2" })]);
    expect(db.request({ ...stopReq, kind: "restart" })).toMatchObject({ kind: "restart" });
    db.addEvents([ev("run_start", {}, { run: "r2" })]);
    expect(db.request({ ...stopReq, kind: "resume" })).toEqual({ refused: "run is not the ticket's newest run" });
  });

  it("refuses a second restart once one is done, even after a pipeline cancel", () => {
    const db = openDb(":memory:");
    db.addEvents([ev("run_start"), ev("step_start", {}, { step: "triage" })]);
    db.finish((db.request(stopReq) as { id: string }).id, "cancelled");
    const restart = db.request({ ...stopReq, kind: "restart" }) as { id: string };
    expect(db.restarted("r1")).toBe(false);
    db.finish(restart.id, "done");
    expect(db.restarted("r1")).toBe(true);
    expect(db.request({ ...stopReq, kind: "restart" })).toEqual({ refused: "run already restarted" });
  });

  it("saves the audit event with the request, and neither when refused", () => {
    const db = openDb(":memory:");
    db.addEvents([ev("run_start")]);
    const row = db.request(stopReq) as { at: string };
    expect(db.events({ run: "r1" }).events.at(-1)).toMatchObject({ type: "stop", at: row.at, data: { user: "ana" } });
    db.request(stopReq);
    expect(db.events({ run: "r1" }).events.filter((e) => e.type === "stop")).toHaveLength(1);
  });

  it("a stopped step_end finishes the pending stop request", () => {
    const db = openDb(":memory:");
    db.addEvents([ev("run_start")]);
    db.request(stopReq);
    db.addEvents([ev("step_end", { outcome: "stopped" }, { step: "triage" })]);
    expect(db.requests({ pending: true })).toHaveLength(0);
    expect(db.requests({})[0]).toMatchObject({ outcome: "stopped" });
    expect(db.requests({})[0].doneAt).toBeTruthy();
  });

  it("cancelled keeps the request pending and survives a later finish", () => {
    const db = openDb(":memory:");
    db.addEvents([ev("run_start")]);
    const r = db.request(stopReq) as { id: string };
    db.finish(r.id, "cancelled");
    expect(db.requests({ pending: true })[0]).toMatchObject({ id: r.id, outcome: "cancelled" });
    db.finish(r.id, "done");
    expect(db.requests({ pending: true })).toHaveLength(0);
    expect(db.requests({})[0].outcome).toBe("cancelled");
    expect(db.requests({})[0].doneAt).toBeTruthy();
  });

  it("after a pipeline cancel allows restart but refuses resume (spec 6.1)", () => {
    const db = openDb(":memory:");
    db.addEvents([ev("run_start"), ev("step_start", {}, { step: "triage" })]);
    const r = db.request(stopReq) as { id: string };
    db.finish(r.id, "cancelled");
    expect(db.request({ ...stopReq, kind: "resume" })).toEqual({ refused: "the pipeline was cancelled, use Restart" });
    expect(db.request({ ...stopReq, kind: "restart" })).toMatchObject({ kind: "restart" });
  });

  it("filters by target and by age", () => {
    const db = openDb(":memory:");
    db.addEvents([ev("run_start"), ev("run_start", {}, { run: "r2", target: "other" })]);
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
});
