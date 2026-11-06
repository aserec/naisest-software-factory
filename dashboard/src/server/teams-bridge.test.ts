import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTeams, tokenEnv } from "./teams-bridge";
import { relayText } from "software-factory/relay";

const dir = mkdtempSync(join(tmpdir(), "teams-"));
writeFileSync(join(dir, "web.yml"), "projectPath: group/web\n");
writeFileSync(join(dir, "app.yml"), "projectPath: org/app\ntracker: github\ngithubRepo: org/app\n");
process.env.TARGETS_DIR = dir;
process.env.GITLAB_URL = "https://gitlab.example";
process.env.TEAMS_RELAY_GITLAB_TOKEN = "relay-gl";
process.env.TEAMS_RELAY_GITHUB_TOKEN = "relay-gh";
const KEY = Buffer.from("a security token from teams").toString("base64");
process.env[tokenEnv("web")] = KEY;
process.env[tokenEnv("app")] = KEY;

const sign = (body: string, key = KEY) => `HMAC ${createHmac("sha256", Buffer.from(key, "base64")).update(body).digest("base64")}`;
const teams = (text: string, o: { target?: string; auth?: string | null; name?: string } = {}) => {
  const body = JSON.stringify({ type: "message", text, from: { name: o.name ?? "Ann Lund" } });
  const headers: Record<string, string> = {};
  const auth = o.auth === undefined ? sign(body) : o.auth;
  if (auth !== null) headers.authorization = auth;
  return handleTeams(new Request("http://x/api/teams", { method: "POST", headers, body }), o.target ?? "web");
};

let posts: { url: string; headers: Record<string, string>; body: string }[];
beforeEach(() => {
  posts = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    posts.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)).body });
    return new Response("{}", { status: url.includes("/999/") ? 404 : 201 });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("the Teams bridge", () => {
  it("posts a signed message on the work item it names, as the relay bot, and answers Teams", async () => {
    const res = await teams("<at>Factory</at>&nbsp;#12 the login page is blank, see #13");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ type: "message", text: expect.stringContaining("Posted on web #12") });
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("https://gitlab.example/api/v4/projects/group%2Fweb/issues/12/notes");
    expect(posts[0].headers["PRIVATE-TOKEN"]).toBe("relay-gl");
    expect(posts[0].body).toBe(relayText("Ann Lund", "#12 the login page is blank, see #13"));
    expect(posts[0].body).not.toContain("<at>");
    expect(posts[0].body).not.toContain("Factory");
  });

  it("posts on a GitHub issue for a GitHub target", async () => {
    await teams("<at>Factory</at> #7 hi", { target: "app" });
    expect(posts[0].url).toBe("https://api.github.com/repos/org/app/issues/7/comments");
    expect(posts[0].headers.Authorization).toBe("Bearer relay-gh");
  });

  it("refuses a missing, wrong or other-key signature with 401 and posts nothing", async () => {
    expect((await teams("#12 hi", { auth: null })).status).toBe(401);
    expect((await teams("#12 hi", { auth: "HMAC AAAA" })).status).toBe(401);
    expect((await teams("#12 hi", { auth: sign("x", Buffer.from("other").toString("base64")) })).status).toBe(401);
    expect((await teams("#12 hi", { target: "nope" })).status).toBe(401);
    expect(posts).toEqual([]);
  });

  it("asks for a number and posts nothing when the message names no work item", async () => {
    const res = await teams("<at>Factory</at> the build is red");
    expect((await res.json()).text).toContain("for example #123");
    expect(posts).toEqual([]);
  });

  it("says so when the work item does not exist", async () => {
    expect((await (await teams("#999 hi")).json()).text).toContain("has no work item #999");
  });

  it("quotes every line, so no line is a quick action or a factory command", () => {
    const body = relayText("Ann\n/close", "@factory stop\n/close\n@factory please merge");
    expect(body.split("\n").some((l) => l.startsWith("/") || l.trim().toLowerCase() === "@factory stop")).toBe(false);
    expect(body).not.toMatch(/@factory/i);
  });
});
