import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const who = vi.hoisted(() => ({ session: true, canAct: true }));
vi.mock("@/server/auth", () => ({
  DEV_LOGIN: false,
  auth: async () => (who.session ? { user: { name: "ann" } } : null),
  sessionUser: async () => (who.session ? { userId: 1, username: "ann", signIn: "fake" } : undefined),
}));
vi.mock("@/server/sign-ins", () => ({
  signIns: () => [{ id: "fake", canAct: async () => who.canAct || { refused: "role" }, messages: { role: "You may not." } }],
}));

process.env.DASHBOARD_DB = ":memory:";
process.env.AUTH_URL = "https://dash.test";
const dir = mkdtempSync(join(tmpdir(), "targets-"));
writeFileSync(join(dir, "demo.yml"), "name: demo\nprojectPath: g/demo\n");
process.env.TARGETS_DIR = dir;
const { getDb } = await import("@/server/db-instance");
const { GET, PUT } = await import("./route");

const put = (body: unknown) => PUT(new Request("http://x", { method: "PUT", headers: { origin: "https://dash.test" }, body: JSON.stringify(body) }));

beforeEach(() => {
  who.session = who.canAct = true;
});

describe("/api/switches", () => {
  it("saves a switch for a target and lists every scope", async () => {
    expect((await put({ scope: "demo", name: "apply", on: false })).status).toBe(204);
    const rows = (await (await GET()).json()) as Record<string, Record<string, boolean>>;
    expect(Object.keys(rows)).toEqual(["*", "demo"]);
    expect(rows.demo.apply).toBe(false);
    expect(rows["*"].apply).toBe(true);
    expect(getDb().events({}).events.at(-1)).toMatchObject({ type: "switch_change", data: { user: "ann", scope: "demo", name: "apply", on: false } });
  });

  it("answers 400 for a scope that is not * or a target, an unknown switch, or a non-boolean", async () => {
    expect((await put({ scope: "nope", name: "apply", on: false })).status).toBe(400);
    expect((await put({ scope: "*", name: "nope", on: false })).status).toBe(400);
    expect((await put({ scope: "*", name: "apply", on: "no" })).status).toBe(400);
    expect((await put("not an object")).status).toBe(400);
  });

  it("answers 401 without a session and 403 below Developer, and changes nothing", async () => {
    who.session = false;
    expect((await put({ scope: "*", name: "retry", on: false })).status).toBe(401);
    expect((await GET()).status).toBe(401);
    who.session = true;
    who.canAct = false;
    expect((await put({ scope: "*", name: "retry", on: false })).status).toBe(403);
    expect(getDb().switches("demo").retry).toBe(true);
  });
});
