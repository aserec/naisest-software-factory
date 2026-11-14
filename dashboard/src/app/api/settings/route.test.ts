import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const who = vi.hoisted(() => ({ session: true, canAct: true }));
vi.mock("@/server/auth", () => ({
  DEV_LOGIN: false,
  auth: async () => (who.session ? { user: { name: "ann" } } : null),
  sessionUser: async () => (who.session ? { userId: 1, username: "ann", signIn: "fake" } : undefined),
  factoryAuthorized: () => true,
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
const control = await import("../factory/control/route");

const put = (body: unknown) => PUT(new Request("http://x", { method: "PUT", headers: { origin: "https://dash.test" }, body: JSON.stringify(body) }));
const FILE = "install: pnpm i\nlint: pnpm lint\ntest: pnpm test\nbuild: pnpm build\n";

beforeEach(() => {
  who.session = who.canAct = true;
});

describe("/api/settings", () => {
  it("saves a target's settings, audits who saved them, and sends them to the factory with the switches", async () => {
    expect((await put({ target: "demo", thresholds: { diffRiskMax: 6 }, factoryFile: FILE })).status).toBe(204);
    const rows = (await (await GET()).json()) as Record<string, { thresholds: object; factoryFile?: string; user?: string }>;
    expect(rows.demo).toMatchObject({ thresholds: { diffRiskMax: 6 }, factoryFile: FILE, user: "ann" });
    expect(getDb().events({}).events.at(-1)).toMatchObject({ type: "settings_change", data: { user: "ann", thresholds: { diffRiskMax: 6 }, factoryFile: FILE } });
    const state = await (await control.GET(new Request("http://x/api/factory/control?target=demo"))).json();
    expect(state.settings).toEqual({ thresholds: { diffRiskMax: 6 }, factoryFile: FILE });
  });

  it("saves the auto_merge switch in the same write as the limits, and saves neither when a value is bad", async () => {
    expect((await put({ target: "demo", thresholds: { diffRiskMax: 4 }, autoMerge: false })).status).toBe(204);
    expect(getDb().switches("demo").auto_merge).toBe(false);
    expect((await put({ target: "demo", thresholds: { diffRiskMax: "x" }, autoMerge: true })).status).toBe(400);
    expect(getDb().switches("demo").auto_merge).toBe(false);
    expect((await put({ target: "demo", thresholds: {}, autoMerge: "yes" })).status).toBe(400);
  });

  it("saves the agents' language for the factory, refuses an unknown one, and an empty one falls back to the target file", async () => {
    expect((await put({ target: "demo", thresholds: {}, language: "de" })).status).toBe(204);
    const state = await (await control.GET(new Request("http://x/api/factory/control?target=demo"))).json();
    expect(state.settings).toEqual({ thresholds: {}, language: "de" });
    expect((await put({ target: "demo", thresholds: {}, language: "fr" })).status).toBe(400);
    expect(getDb().settings("demo").language).toBe("de");
    await put({ target: "demo", thresholds: {}, language: "" });
    expect(getDb().settings("demo").language).toBeUndefined();
  });

  it("an empty factoryFile clears the commands, so the factory reads the repo's file again", async () => {
    await put({ target: "demo", thresholds: {}, factoryFile: FILE });
    expect((await put({ target: "demo", thresholds: {}, factoryFile: "  " })).status).toBe(204);
    expect(getDb().settings("demo").factoryFile).toBeUndefined();
  });

  it("refuses an unknown target, a bad threshold and commands the factory could not run, and keeps the old value", async () => {
    await put({ target: "demo", thresholds: { clarityMin: 7 } });
    expect((await put({ target: "nope", thresholds: {} })).status).toBe(400);
    const bad = await put({ target: "demo", thresholds: { diffRiskMax: 99 } });
    expect([bad.status, await bad.text()]).toEqual([400, "Settings: diffRiskMax must be a whole number from 2 to 10"]);
    const noBuild = await put({ target: "demo", thresholds: {}, factoryFile: "install: i\nlint: l\ntest: t\n" });
    expect(noBuild.status).toBe(400);
    expect(await noBuild.text()).toContain("build");
    expect(getDb().settings("demo").thresholds).toEqual({ clarityMin: 7 });
  });

  it("answers 401 without a session and 403 to a person who may not act, and changes nothing", async () => {
    await put({ target: "demo", thresholds: {} });
    who.session = false;
    expect((await put({ target: "demo", thresholds: { diffRiskMax: 2 } })).status).toBe(401);
    expect((await GET()).status).toBe(401);
    who.session = true;
    who.canAct = false;
    expect((await put({ target: "demo", thresholds: { diffRiskMax: 2 } })).status).toBe(403);
    expect(getDb().settings("demo").thresholds).toEqual({});
  });
});
