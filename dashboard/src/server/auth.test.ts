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

const load = () => import("./auth");

describe("session", () => {
  const SECRET = "test-secret-test-secret-test-secret";
  const cookieFor = async (token: Record<string, unknown>) => {
    const name = "__Secure-authjs.session-token";
    return `${name}=${await encode({ token, secret: SECRET, salt: name })}`;
  };

  it("the jwt callback keeps only the user id, the username, the sign-in and the sign-in time", async () => {
    const { authConfig } = await load();
    const t = await authConfig.callbacks.jwt({ token: { name: "Dev Name", email: "d@x" }, account: { provider: "gitlab", access_token: "at", refresh_token: "rt" }, profile: { id: 7, username: "dev" } });
    expect(Object.keys(t!).sort()).toEqual(["loginAt", "signIn", "userId", "username"]);
    expect(t).toMatchObject({ userId: 7, username: "dev", signIn: "gitlab" });
  });

  it("the jwt callback keeps a GitHub user's login and marks the session as GitHub", async () => {
    const { authConfig } = await load();
    const t = await authConfig.callbacks.jwt({ token: {}, account: { provider: "github", access_token: "at" }, profile: { id: 9, login: "ann", name: "Ann" } });
    expect(t).toMatchObject({ userId: 9, username: "ann", signIn: "github" });
    expect(Object.keys(t!).sort()).toEqual(["loginAt", "signIn", "userId", "username"]);
  });

  it("a session token from before the sign-in seam keeps its sign-in", async () => {
    const { authConfig } = await load();
    const session = (token: object) => authConfig.callbacks.session({ session: {}, token });
    expect(await session({ userId: 1, username: "a", loginAt: Date.now() })).toMatchObject({ signIn: "gitlab" });
    expect(await session({ userId: 1, username: "a", loginAt: Date.now(), provider: "github" })).toMatchObject({ signIn: "github" });
    expect(await session({ userId: 1, username: "a", loginAt: Date.now(), signIn: "github" })).toMatchObject({ signIn: "github" });
  });

  it("sessionUser gives the id and username from the cookie, and nothing without one or 8 h after sign-in", async () => {
    const { sessionUser } = await load();
    request.cookie = await cookieFor({ userId: 7, username: "dev", loginAt: Date.now() - 7 * 3_600_000 });
    expect(await sessionUser()).toEqual({ userId: 7, username: "dev", signIn: "gitlab" });
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
    const f = vi.fn(async () => Response.json({}));
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
