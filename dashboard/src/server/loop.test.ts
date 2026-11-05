import { backupDir } from "./db-instance";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "software-factory/run-events";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { openDb } from "./db";
import { newLoopState, startDispatches, tick } from "./loop";

const ev = (type: RunEvent["type"], run: string, extra: Partial<RunEvent> = {}): RunEvent => ({ id: randomUUID(), run, at: new Date().toISOString(), target: "demo", ticket: "7", type, data: {}, ...extra }) as RunEvent;
const later = (s: number) => new Date(Date.now() + s * 1000);

let db: ReturnType<typeof openDb>;
let ci: { cancel: Mock<(run: string) => Promise<void>>; importEvents: Mock<() => Promise<number>>; startDispatch: Mock<(target: string) => Promise<void>> };
let state: ReturnType<typeof newLoopState>;
beforeEach(() => {
  db = openDb(":memory:");
  ci = { cancel: vi.fn(async () => {}), importEvents: vi.fn(async () => 0), startDispatch: vi.fn(async () => {}) };
  state = { ...newLoopState(), lastImport: Date.now() + 1e9, backupDay: "done" }; // no import or backup unless a test wants one
  db.addEvents([ev("run_start", "r1"), ev("label_change", "r1", { data: { to: "running" } }), ev("step_start", "r1", { pipeline: "6" }), ev("step_start", "r1", { pipeline: "7" })]);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const stop = () => db.request({ kind: "stop", run: "r1", target: "demo", ticket: "7", user: "ann" });

describe("tick: stop fallback", () => {
  it("cancels nothing at 59 s, cancels the newest pipeline once at 61 s, and never again", async () => {
    stop();
    await tick({ db, ci, now: later(59) }, state);
    expect(ci.cancel).not.toHaveBeenCalled();
    await tick({ db, ci, now: later(61) }, state);
    expect(ci.cancel.mock.calls).toEqual([["7"]]);
    expect(db.requests({ pending: true })).toMatchObject([{ outcome: "cancelled" }]); // still pending for the poller (R4)
    await tick({ db, ci, now: later(120) }, state);
    expect(ci.cancel).toHaveBeenCalledTimes(1);
  });

  it("never cancels a stop that already finished as stopped", async () => {
    stop();
    db.addEvents([ev("step_end", "r1", { data: { outcome: "stopped" } })]);
    await tick({ db, ci, now: later(120) }, state);
    expect(ci.cancel).not.toHaveBeenCalled();
  });

  it("finishes the stop as done without a cancel when the run ended on its own", async () => {
    stop();
    db.addEvents([ev("run_end", "r1", { data: { outcome: "done" } })]);
    await tick({ db, ci, now: later(120) }, state);
    expect(ci.cancel).not.toHaveBeenCalled();
    expect(db.requests({})).toMatchObject([{ kind: "stop", outcome: "done" }]);
    expect(db.requests({ pending: true })).toEqual([]);
  });

  it("leaves the stop pending when the run has no pipeline yet, and cancels once one arrives", async () => {
    db.addEvents([ev("run_start", "r2"), ev("label_change", "r2", { data: { to: "running" } })]);
    db.request({ kind: "stop", run: "r2", target: "demo", ticket: "7", user: "ann" });
    await tick({ db, ci, now: later(120) }, state);
    expect(ci.cancel).not.toHaveBeenCalled();
    expect(db.requests({ pending: true }).find((r) => r.run === "r2")?.outcome).toBeUndefined();
    db.addEvents([ev("step_start", "r2", { pipeline: "9" })]);
    await tick({ db, ci, now: later(130) }, state);
    expect(ci.cancel).toHaveBeenCalledWith("9");
  });

  it("retries a failed cancel on the next tick", async () => {
    stop();
    ci.cancel.mockRejectedValueOnce(new Error("GitLab 500"));
    await tick({ db, ci, now: later(61) }, state);
    await tick({ db, ci, now: later(71) }, state);
    expect(ci.cancel).toHaveBeenCalledTimes(2);
    expect(db.requests({ pending: true })[0].outcome).toBe("cancelled");
  });

  it("still cancels when the import throws", async () => {
    stop();
    state.lastImport = 0;
    ci.importEvents.mockRejectedValue(new Error("boom"));
    await tick({ db, ci, now: later(61) }, state);
    expect(ci.cancel).toHaveBeenCalledWith("7");
  });
});

describe("tick: import and backup", () => {
  it("imports at most every 10 minutes", async () => {
    state.lastImport = 0;
    const t0 = Date.now();
    await tick({ db, ci, now: new Date(t0) }, state);
    await tick({ db, ci, now: new Date(t0 + 599_000) }, state);
    expect(ci.importEvents).toHaveBeenCalledTimes(1);
    await tick({ db, ci, now: new Date(t0 + 600_000) }, state);
    expect(ci.importEvents).toHaveBeenCalledTimes(2);
  });

  it("backs up once a day, after 03:00 UTC", async () => {
    const dir = mkdtempSync(join(tmpdir(), "backups-"));
    vi.stubEnv("BACKUP_DIR", dir);
    state.backupDay = "";
    await tick({ db, ci, now: new Date("2026-10-30T02:59:00Z") }, state);
    expect(readdirSync(dir)).toEqual([]);
    await tick({ db, ci, now: new Date("2026-10-30T03:00:00Z") }, state);
    await tick({ db, ci, now: new Date("2026-10-30T09:00:00Z") }, state);
    expect(readdirSync(dir)).toEqual(["factory-2026-10-30.db"]);
    const backup = vi.spyOn(db, "backup");
    await tick({ db, ci, now: new Date("2026-10-30T10:00:00Z") }, state);
    expect(backup).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("backs up next to the database when BACKUP_DIR is not set", () => {
    vi.stubEnv("BACKUP_DIR", undefined);
    vi.stubEnv("DASHBOARD_DB", "../.cache/factory.db");
    expect(backupDir()).toBe(join("../.cache", "backups"));
    vi.stubEnv("DASHBOARD_DB", undefined);
    expect(backupDir()).toBe("/data/backups");
    vi.unstubAllEnvs();
  });
});

describe("startDispatches", () => {
  const add = (target = "demo") => db.addDispatch({ target, source: "pip-audit", key: "k", title: "t", details: "" });
  const run = (s: number) => startDispatches({ db, ci, now: later(s) });

  it("starts one run per target, again only after 15 minutes while the dispatch waits, and never once it is done", async () => {
    add();
    add();
    await run(0);
    expect(ci.startDispatch.mock.calls).toEqual([["demo"]]);
    await run(14 * 60);
    expect(ci.startDispatch).toHaveBeenCalledTimes(1);
    await run(16 * 60); // the run failed: the dispatches still wait
    expect(ci.startDispatch).toHaveBeenCalledTimes(2);
    db.dispatches("demo").forEach((x) => db.dispatchDone(x.id));
    await run(60 * 60);
    expect(ci.startDispatch).toHaveBeenCalledTimes(2);
  });

  it("waits while the dispatches switch is off, and a failed start is tried again later", async () => {
    add();
    db.setSwitch("demo", "dispatches", false, "ann");
    await run(0);
    expect(ci.startDispatch).not.toHaveBeenCalled();
    db.setSwitch("demo", "dispatches", true, "ann");
    ci.startDispatch.mockRejectedValueOnce(new Error("GitLab down"));
    await run(1);
    await run(2);
    expect(ci.startDispatch).toHaveBeenCalledTimes(1);
    await run(16 * 60);
    expect(ci.startDispatch).toHaveBeenCalledTimes(2);
  });
});
