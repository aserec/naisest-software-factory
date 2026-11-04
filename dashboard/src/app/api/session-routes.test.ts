import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "software-factory/run-events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ on: true }));
const gitlab = vi.hoisted(() => ({ board: vi.fn(), jobLog: vi.fn() }));
vi.mock("@/server/auth", () => ({ auth: async () => (session.on ? { user: { name: "ann" } } : null), factoryAuthorized: () => true }));
vi.mock("@/server/gitlab-instance", () => ({ getGitLab: () => gitlab }));

process.env.DASHBOARD_DB = ":memory:";
const dir = mkdtempSync(join(tmpdir(), "targets-"));
writeFileSync(join(dir, "demo.yml"), "name: demo\nprojectPath: g/demo\n");
process.env.TARGETS_DIR = dir;

const { getDb } = await import("@/server/db-instance");
const { GET: getBoard } = await import("./board/route");
const { GET: getEvents } = await import("./events/route");
const { GET: getLog } = await import("./jobs/[job]/log/route");

const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const ev = (type: RunEvent["type"], min: number, run: string, data: Record<string, unknown> = {}, step?: string): RunEvent => ({ id: randomUUID(), run, at: at(min), target: "demo", ticket: "7", type, data, ...(step ? { step } : {}) });
const item = (ticket: string) => ({ target: "demo", ticket, title: `T${ticket}`, state: "factory_running", url: "u", updatedAt: "" });
const log = (job: string) => getLog(new Request("http://x"), { params: Promise.resolve({ job }) });

beforeEach(() => {
  session.on = true;
  gitlab.board.mockResolvedValue([item("7"), item("8")]);
});

describe("session-only routes", () => {
  it("answer 401 without a session", async () => {
    session.on = false;
    expect((await getBoard()).status).toBe(401);
    expect((await getEvents(new Request("http://x/api/events?run=r"))).status).toBe(401);
    expect((await log("1")).status).toBe(401);
    expect(gitlab.jobLog).not.toHaveBeenCalled();
  });
});

describe("GET /api/board", () => {
  it("joins the latest run per ticket and marks a step past its limit as stuck", async () => {
    getDb().addEvents([ev("run_start", 300, "old"), ev("run_start", 200, "new"), ev("step_start", 200, "new", {}, "prepare-patch"), ev("usage", 190, "new", { costUsd: 1.25 }), ev("decision", 180, "new", { auto: false, reasons: [], risk: 6, changeUrl: "http://gl/mr/1" })]);
    const rows = (await (await getBoard()).json()) as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ ticket: "7", run: "new", costUsd: 1.25, stuck: true, step: "prepare-patch", mergeRisk: 6, mrUrl: "http://gl/mr/1" });
    expect(rows[1]).toMatchObject({ ticket: "8", stuck: false });
    expect(rows[1].run).toBeUndefined();
  });

  it("answers 502 when GitLab fails", async () => {
    gitlab.board.mockRejectedValue(new Error("GitLab 500"));
    expect((await getBoard()).status).toBe(502);
  });
});

describe("GET /api/events", () => {
  it("returns the events after the cursor for one run", async () => {
    getDb().addEvents([ev("run_start", 5, "ev1"), ev("step_start", 4, "ev1", {}, "triage")]);
    const first = (await (await getEvents(new Request("http://x/api/events?run=ev1"))).json()) as { events: unknown[]; cursor: number };
    expect(first.events).toHaveLength(2);
    getDb().addEvents([ev("step_end", 3, "ev1", { outcome: "next" }, "triage")]);
    const next = (await (await getEvents(new Request(`http://x/api/events?run=ev1&after=${first.cursor}`))).json()) as { events: unknown[] };
    expect(next.events).toHaveLength(1);
  });

  it("asks for a run and a good cursor", async () => {
    expect((await getEvents(new Request("http://x/api/events"))).status).toBe(400);
    expect((await getEvents(new Request("http://x/api/events?run=r&after=-1"))).status).toBe(400);
  });
});

describe("GET /api/jobs/[job]/log", () => {
  it("answers 400 for a bad id and never calls GitLab", async () => {
    expect((await log("1/../2")).status).toBe(400);
    expect(gitlab.jobLog).not.toHaveBeenCalled();
  });

  it("returns the log text, or 502", async () => {
    gitlab.jobLog.mockResolvedValue("line");
    expect(await (await log("12")).text()).toBe("line");
    gitlab.jobLog.mockRejectedValue(new Error("GitLab 404"));
    expect((await log("12")).status).toBe(502);
  });
});
