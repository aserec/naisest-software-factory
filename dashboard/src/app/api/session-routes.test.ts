import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "software-factory/run-events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ on: true }));
const ci = vi.hoisted(() => ({ jobLog: vi.fn() }));
const board = vi.hoisted(() => ({ board: vi.fn() }));
vi.mock("@/server/auth", () => ({ auth: async () => (session.on ? { user: { name: "ann" } } : null), factoryAuthorized: () => true }));
vi.mock("@/server/compose", () => ({ getBoard: () => board, getCi: () => ci }));

process.env.DASHBOARD_DB = ":memory:";
const dir = mkdtempSync(join(tmpdir(), "targets-"));
writeFileSync(join(dir, "demo.yml"), "name: demo\nprojectPath: g/demo\n");
process.env.TARGETS_DIR = dir;

const { getDb } = await import("@/server/db-instance");
const { GET: getBoard } = await import("./board/route");
const { GET: getEvents } = await import("./events/route");
const { GET: getStream } = await import("./events/stream/route");
const { GET: getLog } = await import("./jobs/[job]/log/route");

const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const ev = (type: RunEvent["type"], min: number, run: string, data: Record<string, unknown> = {}, step?: string): RunEvent => ({ id: randomUUID(), run, at: at(min), target: "demo", ticket: "7", type, data, ...(step ? { step } : {}) }) as RunEvent;
const item = (ticket: string) => ({ target: "demo", ticket, title: `T${ticket}`, state: "running", url: "u", updatedAt: "" });
const log = (job: string) => getLog(new Request("http://x"), { params: Promise.resolve({ job }) });

beforeEach(() => {
  session.on = true;
  board.board.mockResolvedValue([item("7"), item("8")]);
});

describe("session-only routes", () => {
  it("answer 401 without a session", async () => {
    session.on = false;
    expect((await getBoard()).status).toBe(401);
    expect((await getEvents(new Request("http://x/api/events?run=r"))).status).toBe(401);
    expect((await getStream(new Request("http://x/api/events/stream?run=r"))).status).toBe(401);
    expect((await log("1")).status).toBe(401);
    expect(ci.jobLog).not.toHaveBeenCalled();
  });
});

describe("GET /api/board", () => {
  it("joins the latest run per ticket and marks a step past its limit as stuck", async () => {
    getDb().addEvents([ev("run_start", 300, "old"), ev("run_start", 200, "new"), ev("step_start", 200, "new", {}, "prepare-patch"), ev("usage", 190, "new", { costUsd: 1.25 }), ev("decision", 180, "new", { auto: false, reasons: [], risk: 6, changeUrl: "http://gl/mr/1" })]);
    const rows = (await (await getBoard()).json()) as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ ticket: "7", run: "new", costUsd: 1.25, stuck: true, step: "prepare-patch", mergeRisk: 6, changeUrl: "http://gl/mr/1" });
    expect(rows[1]).toMatchObject({ ticket: "8", stuck: false });
    expect(rows[1].run).toBeUndefined();
  });

  // D-P5: a stopped or waiting run is not working, so a long step is not stuck.
  it("does not mark a paused run stuck, however long its last step ran", async () => {
    const of9 = (e: RunEvent): RunEvent => ({ ...e, ticket: "9" });
    board.board.mockResolvedValue([item("9")]);
    getDb().addEvents([of9(ev("run_start", 300, "paused")), of9(ev("step_start", 200, "paused", {}, "prepare-patch")), of9(ev("label_change", 100, "paused", { to: "stopped" }))]);
    const rows = (await (await getBoard()).json()) as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ ticket: "9", run: "paused", stuck: false });
  });

  it("answers 502 when the tracker fails", async () => {
    board.board.mockRejectedValue(new Error("GitLab 500"));
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

describe("GET /api/events/stream", () => {
  afterEach(() => vi.useRealTimers());
  const open = async (url: string, init?: RequestInit) => {
    const abort = new AbortController();
    const res = await getStream(new Request(url, { ...init, signal: abort.signal }));
    const reader = res.body!.getReader();
    const next = async () => new TextDecoder().decode((await reader.read()).value);
    return { res, next, reader, abort };
  };
  const seqs = (chunk: string) => (JSON.parse(chunk.match(/^data: (.*)$/m)![1]) as { seq: number }[]).map((e) => e.seq);

  it("sends the run's events with the last seq as id, then the new ones, and resumes after Last-Event-ID", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    getDb().addEvents([ev("run_start", 5, "st1"), ev("step_start", 4, "st1", {}, "triage")]);
    const { res, next, reader, abort } = await open("http://x/api/events/stream?run=st1");
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const first = await next();
    const [a, b] = seqs(first);
    expect(first).toMatch(new RegExp(`^id: ${b}\n`));
    getDb().addEvents([ev("step_end", 3, "st1", { outcome: "next" }, "triage")]);
    vi.advanceTimersByTime(500);
    const second = await next();
    expect(seqs(second)).toEqual([b + 1]);
    vi.advanceTimersByTime(15_000);
    expect(await next()).toBe(": heartbeat\n\n");
    abort.abort(); // the page went away: the stream closes and stops asking
    expect((await reader.read()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    // A reconnect sends Last-Event-ID, which wins over the after in the URL.
    const again = await open("http://x/api/events/stream?run=st1&after=0", { headers: { "Last-Event-ID": String(a) } });
    expect(seqs(await again.next())).toEqual([b, b + 1]);
    again.abort.abort();
  });

  it("sends an empty first batch for a run without events, and asks for a run", async () => {
    const { next, abort } = await open("http://x/api/events/stream?run=none");
    expect(await next()).toBe("id: 0\ndata: []\n\n");
    abort.abort();
    expect((await getStream(new Request("http://x/api/events/stream"))).status).toBe(400);
  });

  it("ends once the run has a run_end and stayed quiet, and not before", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    getDb().addEvents([ev("run_start", 5, "st2")]);
    const { next, reader } = await open("http://x/api/events/stream?run=st2");
    await next();
    vi.advanceTimersByTime(20_000); // quiet, but the run has not ended: only heartbeats
    expect(await next()).toBe(": heartbeat\n\n");
    getDb().addEvents([ev("run_end", 1, "st2", { outcome: "done" })]);
    vi.advanceTimersByTime(500);
    await next(); // the run_end itself
    vi.advanceTimersByTime(9_000); // 9 s quiet: not yet
    vi.advanceTimersByTime(1_000); // the 30 s heartbeat, then 10 s quiet: the end
    let rest = "";
    for (let r = await reader.read(); !r.done; r = await reader.read()) rest += new TextDecoder().decode(r.value);
    expect(rest).toBe(": heartbeat\n\nevent: end\ndata: \n\n");
  });
});

describe("GET /api/jobs/[job]/log", () => {
  it("answers 400 for a bad id and never calls the CI", async () => {
    expect((await log("1/../2")).status).toBe(400);
    expect(ci.jobLog).not.toHaveBeenCalled();
  });

  it("lets any safe job id through, as the local worker names jobs by words", async () => {
    ci.jobLog.mockResolvedValue("line");
    expect((await log("a.b-c_1")).status).toBe(200);
  });

  it("returns the log text, or 502", async () => {
    ci.jobLog.mockResolvedValue("line");
    expect(await (await log("12")).text()).toBe("line");
    ci.jobLog.mockRejectedValue(new Error("GitLab 404"));
    expect((await log("12")).status).toBe(502);
  });
});
