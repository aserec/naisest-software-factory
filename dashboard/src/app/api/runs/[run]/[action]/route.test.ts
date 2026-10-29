import { randomUUID } from "node:crypto";
import type { RunEvent } from "software-factory/run-events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const who = vi.hoisted(() => ({ session: true, canAct: true }));
vi.mock("@/server/auth", () => ({
  auth: async () => (who.session ? { user: { name: "ann" } } : null),
  sessionActor: async () => (who.session ? { user: "ann", accessToken: "tok" } : undefined),
  canAct: async () => who.canAct,
}));

process.env.DASHBOARD_DB = ":memory:";
const { getDb } = await import("@/server/db-instance");
const { GET, POST } = await import("./route");

const ev = (type: RunEvent["type"], run: string, data: Record<string, unknown> = {}): RunEvent => ({ id: randomUUID(), run, at: new Date().toISOString(), target: "demo", ticket: "7", type, data });
const post = (run: string, action: string) => POST(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ run, action }) });
const state = (run: string) => GET(new Request("http://x"), { params: Promise.resolve({ run, action: "state" }) });
let n = 0;
let run = "";

beforeEach(() => {
  who.session = who.canAct = true;
  run = `run${++n}`;
  getDb().addEvents([ev("run_start", run), ev("label_change", run, { to: "factory_running" })]);
});

describe("POST /api/runs/[run]/[action]", () => {
  it("saves a stop request and a stop event with the user, and refuses a second stop", async () => {
    const res = await post(run, "stop");
    expect(res.status).toBe(200);
    expect(getDb().requests({ target: "demo" }).filter((r) => r.run === run)).toMatchObject([{ kind: "stop", user: "ann" }]);
    expect(getDb().events({ run }).events.at(-1)).toMatchObject({ type: "stop", data: { user: "ann" } });
    const again = await post(run, "stop");
    expect([again.status, await again.text()]).toEqual([409, "already requested"]);
  });

  it("refuses a restart on a run that is not stopped", async () => {
    const res = await post(run, "restart");
    expect([res.status, await res.text()]).toEqual([409, "run is not stopped"]);
  });

  it("accepts a resume on a stopped run", async () => {
    getDb().addEvents([ev("step_end", run, { outcome: "stopped" })]);
    expect((await post(run, "resume")).status).toBe(200);
  });

  it("answers 401 without a session and 403 for a user below Developer, and writes nothing", async () => {
    who.session = false;
    expect((await post(run, "stop")).status).toBe(401);
    who.session = true;
    who.canAct = false;
    expect((await post(run, "stop")).status).toBe(403);
    expect(getDb().requests({ target: "demo" }).filter((r) => r.run === run)).toEqual([]);
    expect(getDb().events({ run }).events.some((e) => e.type === "stop")).toBe(false);
  });

  it("answers 404 for an unknown action or run", async () => {
    expect((await post(run, "delete")).status).toBe(404);
    expect((await post("nope", "stop")).status).toBe(404);
  });
});

describe("GET /api/runs/[run]/state", () => {
  it("gives the label and the pending requests, and flags a cancelled stop without calling it pending", async () => {
    expect(await (await state(run)).json()).toEqual({ label: "factory_running", cancelled: false, pending: [] });
    await post(run, "stop");
    expect(await (await state(run)).json()).toMatchObject({ pending: ["stop"] });
    getDb().finish(getDb().requests({ target: "demo" }).find((r) => r.run === run)!.id, "cancelled");
    expect(await (await state(run)).json()).toMatchObject({ cancelled: true, pending: [] });
  });

  it("answers 401 without a session", async () => {
    who.session = false;
    expect((await state(run)).status).toBe(401);
  });
});
