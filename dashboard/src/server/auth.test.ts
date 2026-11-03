import { encode } from "next-auth/jwt";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// auth() reads the request through next/headers; the test sets what it sees.
const request = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: request.cookie, host: "dash.test", "x-forwarded-proto": "https" }),
}));

beforeEach(() => {
  vi.stubEnv("FACTORY_PROJECT_ID", "42");
  vi.stubEnv("GITLAB_URL", "https://gitlab.test");
  vi.stubEnv("DASHBOARD_URL", "https://dash.test");
  vi.stubEnv("AUTH_SECRET", "test-secret-test-secret-test-secret");
  vi.stubEnv("GITLAB_OAUTH_CLIENT_ID", "id");
  vi.stubEnv("GITLAB_OAUTH_CLIENT_SECRET", "secret");
  vi.stubEnv("GITLAB_READ_TOKEN", "read-token");
});

// A fake GitLab: /user answers only the user's token, the member read answers only the server's read token.
function fakeGitlab(member: number | { status: number } | { level: number; state: string }) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const h = new Headers(init?.headers);
    if (u.endsWith("/api/v4/user")) return h.get("authorization") === "Bearer user-token" ? Response.json({ id: 7, username: "dev" }) : new Response("no", { status: 401 });
    if (u.endsWith("/projects/42/members/all/7")) {
      if (h.get("private-token") !== "read-token" || h.has("authorization")) return new Response("no", { status: 401 });
      if (typeof member === "number") return Response.json({ access_level: member, state: "active" });
      return "status" in member ? new Response("no", { status: member.status }) : Response.json({ access_level: member.level, state: member.state });
    }
    return new Response("?", { status: 404 });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const load = () => import("./auth");
const down = vi.fn(async () => {
  throw new Error("network");
}) as unknown as typeof fetch;

describe("sign-in role check", () => {
  it("accepts a Developer (30), reading the member with the read token", async () => {
    const { checkRole } = await load();
    expect(await checkRole("user-token", fakeGitlab(30))).toEqual({ user: "dev", userId: 7, level: 30 });
  });

  it("refuses a Reporter (20), a non-member (404) and a blocked Developer with the exact text", async () => {
    const { checkRole, REFUSAL } = await load();
    expect(REFUSAL).toBe("You need the Developer role on the factory project.");
    for (const m of [20, { status: 404 }, { level: 30, state: "blocked" }]) expect(await checkRole("user-token", fakeGitlab(m))).toEqual({ refused: REFUSAL });
  });

  it("says GitLab did not confirm the role on a 500, a thrown error, or a refused user token", async () => {
    const { checkRole, REFUSAL } = await load();
    for (const [token, f] of [["user-token", fakeGitlab({ status: 500 })], ["user-token", down], ["wrong", fakeGitlab(30)]] as const) {
      const r = (await checkRole(token, f)) as { refused: string };
      expect(r.refused).toMatch(/did not confirm/);
      expect(r.refused).not.toBe(REFUSAL);
    }
  });
});

describe("canAct (Ruling R22)", () => {
  it("is true at 30 and active, read with the server's read token", async () => {
    const { canAct } = await load();
    const f = fakeGitlab(30);
    expect(await canAct(7, f)).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("is false at 20, on a 404, for a blocked user, on a non-OK answer and on a thrown error", async () => {
    const { canAct } = await load();
    for (const f of [fakeGitlab(20), fakeGitlab({ status: 404 }), fakeGitlab({ level: 40, state: "blocked" }), fakeGitlab({ status: 500 }), down]) expect(await canAct(7, f)).toBe(false);
  });
});

describe("session", () => {
  const SECRET = "test-secret-test-secret-test-secret";
  const cookieFor = async (token: Record<string, unknown>) => {
    const name = "__Secure-authjs.session-token";
    return `${name}=${await encode({ token, secret: SECRET, salt: name })}`;
  };

  it("the jwt callback keeps only the user id, the username and the sign-in time", async () => {
    const { authConfig } = await load();
    const t = await authConfig.callbacks.jwt({ token: { name: "Dev Name", email: "d@x" }, account: { access_token: "at", refresh_token: "rt" }, profile: { id: 7, username: "dev" } });
    expect(Object.keys(t!).sort()).toEqual(["loginAt", "userId", "username"]);
    expect(t).toMatchObject({ userId: 7, username: "dev" });
  });

  it("the jwt callback keeps a GitHub user's login and marks the session as GitHub", async () => {
    const { authConfig } = await load();
    const t = await authConfig.callbacks.jwt({ token: {}, account: { provider: "github", access_token: "at" }, profile: { id: 9, login: "ann", name: "Ann" } });
    expect(t).toMatchObject({ userId: 9, username: "ann", provider: "github" });
    expect(Object.keys(t!).sort()).toEqual(["loginAt", "provider", "userId", "username"]);
  });

  it("sessionUser gives the id and username from the cookie, and nothing without one or 8 h after sign-in", async () => {
    const { sessionUser } = await load();
    request.cookie = await cookieFor({ userId: 7, username: "dev", loginAt: Date.now() - 7 * 3_600_000 });
    expect(await sessionUser()).toEqual({ userId: 7, username: "dev" });
    request.cookie = await cookieFor({ userId: 7, username: "dev", loginAt: Date.now() - 8 * 3_600_000 - 1000 });
    expect(await sessionUser()).toBeUndefined();
    request.cookie = await cookieFor({ userId: 7, accessToken: "old", loginAt: Date.now() }); // a cookie from before R22
    expect(await sessionUser()).toBeUndefined();
    request.cookie = "";
    expect(await sessionUser()).toBeUndefined();
  });
});

describe("Auth.js wiring", () => {
  it("sends the user to GitLab with read_user, a PKCE challenge and a state", async () => {
    const { handlers } = await load();
    const origin = "https://evil.test"; // a forged Host must not reach the redirect
    const csrf = await handlers.GET(new NextRequest(`${origin}/api/auth/csrf`));
    const { csrfToken } = (await csrf.json()) as { csrfToken: string };
    const cookie = csrf.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const res = await handlers.POST(
      new NextRequest(`${origin}/api/auth/signin/gitlab`, {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrfToken }),
      }),
    );
    const to = new URL(res.headers.get("location") ?? "");
    expect(`${to.origin}${to.pathname}`).toBe("https://gitlab.test/oauth/authorize");
    expect(to.searchParams.get("redirect_uri")).toBe("https://dash.test/api/auth/callback/gitlab");
    expect(to.searchParams.get("scope")).toBe("read_user");
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    expect(to.searchParams.get("code_challenge")).toBeTruthy();
    expect(to.searchParams.get("state")).toBeTruthy();
  });

  it("never reaches GitLab for a callback with a state it did not issue", async () => {
    const { handlers } = await load();
    const f = fakeGitlab(30);
    vi.stubGlobal("fetch", f);
    const res = await handlers.GET(new NextRequest("https://dash.test/api/auth/callback/gitlab?code=x&state=wrong"));
    vi.unstubAllGlobals();
    expect(f).not.toHaveBeenCalled();
    // Auth.js answers a bad state with a redirect to the error page, not a 400.
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/sign-in?error=");
    expect(res.headers.get("set-cookie") ?? "").not.toContain("session-token");
  });
});
