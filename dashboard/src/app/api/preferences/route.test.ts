import { beforeEach, describe, expect, it, vi } from "vitest";

const who = vi.hoisted(() => ({ user: { userId: 1, username: "ann", signIn: "github" } as { userId: number; username: string; signIn: string } | undefined }));
vi.mock("@/server/auth", () => ({ DEV_LOGIN: false, sessionUser: async () => who.user }));
vi.mock("@/server/sign-ins", () => ({ signIns: () => [{ id: "github", name: "GitHub" }] }));

process.env.DASHBOARD_DB = ":memory:";
process.env.AUTH_URL = "https://dash.test";
const { getDb } = await import("@/server/db-instance");
const { GET, PUT } = await import("./route");

const put = (body: unknown, origin = "https://dash.test") => PUT(new Request("http://x", { method: "PUT", headers: { origin }, body: JSON.stringify(body) }));

beforeEach(() => {
  who.user = { userId: 1, username: "ann", signIn: "github" };
});

describe("/api/preferences", () => {
  it("answers the defaults, saves a change per user, and keeps what the change left out", async () => {
    expect(await (await GET()).json()).toEqual({ user: { username: "ann", signIn: "GitHub" }, prefs: { theme: "system", notify: false, insightsRange: "7d" } });
    expect(await (await put({ theme: "dark" })).json()).toMatchObject({ theme: "dark" });
    await put({ insightsRange: "30d" });
    expect((await (await GET()).json()).prefs).toEqual({ theme: "dark", notify: false, insightsRange: "30d" });
    // Same user id on another sign-in is another person.
    who.user = { userId: 1, username: "ann", signIn: "gitlab" };
    expect((await (await GET()).json()).prefs.theme).toBe("system");
  });

  it("falls back to the default for a saved value the schema no longer takes", async () => {
    getDb().setPreferences("github:1", { theme: "neon", notify: true });
    expect((await (await GET()).json()).prefs).toEqual({ theme: "system", notify: true, insightsRange: "7d" });
  });

  it("answers 400 for an unknown key or a bad value, 403 cross-site, 401 signed out, and saves nothing", async () => {
    who.user = { userId: 2, username: "bob", signIn: "github" };
    expect((await put({ theme: "neon" })).status).toBe(400);
    expect((await put({ colour: "red" })).status).toBe(400);
    expect((await put("nope")).status).toBe(400);
    expect((await put({ theme: "dark" }, "https://evil.test")).status).toBe(403);
    expect(getDb().preferences("github:2")).toEqual({});
    who.user = undefined;
    expect((await put({ theme: "dark" })).status).toBe(401);
    expect((await GET()).status).toBe(401);
  });
});
