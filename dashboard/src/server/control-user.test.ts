import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import type { SessionUser } from "./seams";

const who = vi.hoisted(() => ({ user: undefined as SessionUser | undefined, dev: false }));
vi.mock("./auth", () => ({
  get DEV_LOGIN() {
    return who.dev;
  },
  sessionUser: async () => who.user,
}));
const { controlUser } = await import("./control-user");

beforeEach(() => {
  vi.stubEnv("AUTH_URL", "https://dash.test");
  vi.stubEnv("GITHUB_OAUTH_CLIENT_ID", "gh-id");
  vi.stubEnv("GITHUB_READ_TOKEN", "read-token");
  vi.stubEnv("GITLAB_OAUTH_CLIENT_ID", "");
  const dir = mkdtempSync(join(tmpdir(), "targets-"));
  writeFileSync(join(dir, "b.yml"), "name: b\nprojectPath: o/b\ntracker: github\ngithubRepo: o/b\n");
  vi.stubEnv("TARGETS_DIR", dir);
  who.user = { userId: 9, username: "ann", signIn: "github" };
  who.dev = false;
});

const fakeGitHub = (permission: string) => vi.fn(async (url: string) => (url.endsWith("/repos/o/b/collaborators/ann/permission") ? Response.json({ permission }) : new Response("no", { status: 404 })));
const req = (origin = "https://dash.test") => new Request("https://dash.test/api/x", { method: "POST", headers: { origin } });

it("a GitHub user without write access gets 403 with the GitHub message", async () => {
  const f = fakeGitHub("read");
  vi.stubGlobal("fetch", f);
  const r = (await controlUser(req())) as Response;
  expect(r.status).toBe(403);
  expect(await r.text()).toBe("You need write access to the repo of a GitHub target.");
  expect(f).toHaveBeenCalled();
});

it("a GitHub user with write access may act, read again on every call", async () => {
  const f = fakeGitHub("write");
  vi.stubGlobal("fetch", f);
  expect(await controlUser(req())).toBe("ann");
  expect(await controlUser(req())).toBe("ann");
  expect(f).toHaveBeenCalledTimes(2);
});

it("checks the origin first, then the session, and refuses a sign-in that is not on", async () => {
  const f = fakeGitHub("write");
  vi.stubGlobal("fetch", f);
  expect(((await controlUser(req("https://evil.test"))) as Response).status).toBe(403);
  who.user = undefined;
  expect(((await controlUser(req("https://evil.test"))) as Response).status).toBe(403);
  expect(((await controlUser(req())) as Response).status).toBe(401);
  who.user = { userId: 7, username: "dev", signIn: "gitlab" }; // GitLab sign-in is off here
  expect(((await controlUser(req())) as Response).status).toBe(403);
  expect(f).not.toHaveBeenCalled();
});

it("the dev user may act only while the dev login is on", async () => {
  vi.stubGlobal("fetch", fakeGitHub("write"));
  who.user = { userId: -1, username: "dev", signIn: "dev" };
  expect(((await controlUser(req())) as Response).status).toBe(403);
  who.dev = true;
  expect(await controlUser(req())).toBe("dev");
});
