import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.stubEnv("FACTORY_PROJECT_ID", "42");
  vi.stubEnv("GITLAB_URL", "https://gitlab.test");
  vi.stubEnv("AUTH_SECRET", "test-secret-test-secret-test-secret");
  vi.stubEnv("GITLAB_OAUTH_CLIENT_ID", "id");
  vi.stubEnv("GITLAB_OAUTH_CLIENT_SECRET", "secret");
});

// A fake GitLab: /user, the member read (level or status) and the token refresh.
function fakeGitlab(member: number | { status: number }) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith("/api/v4/user")) return Response.json({ id: 7, username: "dev" });
    if (u.includes("/projects/42/members/all/7")) {
      return typeof member === "number" ? Response.json({ access_level: member }) : new Response("no", { status: member.status });
    }
    if (u.endsWith("/oauth/token")) return Response.json({ access_token: "new-at", refresh_token: "new-rt", expires_in: 7200 });
    return new Response("?", { status: 404 });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const load = () => import("./auth");

describe("sign-in role check", () => {
  it("accepts a Developer (30)", async () => {
    const { checkRole } = await load();
    expect(await checkRole("t", fakeGitlab(30))).toEqual({ user: "dev", userId: 7, level: 30 });
  });

  it("refuses a Reporter (20) with the exact text", async () => {
    const { checkRole } = await load();
    expect(await checkRole("t", fakeGitlab(20))).toEqual({ refused: "You need the Developer role on the factory project." });
  });

  it("refuses when GitLab does not answer OK, with a different text", async () => {
    const { checkRole, REFUSAL } = await load();
    const r = await checkRole("t", fakeGitlab({ status: 404 }));
    expect(r).toHaveProperty("refused");
    expect((r as { refused: string }).refused).not.toBe(REFUSAL);
  });
});

describe("current user", () => {
  it("gives the name while the session lasts and nothing after it ended", async () => {
    const { currentUser } = await load();
    const now = Date.parse("2026-10-29T10:00:00Z");
    expect(currentUser({ user: { name: "dev" }, expires: "2026-10-29T18:00:00Z" }, now)).toBe("dev");
    expect(currentUser({ user: { name: "dev" }, expires: "2026-10-29T09:00:00Z" }, now)).toBeUndefined();
    expect(currentUser(null, now)).toBeUndefined();
  });
});

describe("canAct", () => {
  it("is true for 30 and false for 20 and for a 401", async () => {
    const { canAct } = await load();
    expect(await canAct({ accessToken: "t" }, fakeGitlab(30))).toBe(true);
    expect(await canAct({ accessToken: "t" }, fakeGitlab(20))).toBe(false);
    expect(await canAct({ accessToken: "t" }, fakeGitlab({ status: 401 }))).toBe(false);
  });

  it("is false with no session or a failed token refresh", async () => {
    const { canAct } = await load();
    const f = fakeGitlab(30);
    expect(await canAct(undefined, f)).toBe(false);
    expect(await canAct({ accessToken: "t", error: "RefreshFailed" }, f)).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("token refresh", () => {
  const base = { userId: 7, accessToken: "old", refreshToken: "rt", expiresAt: 0, loginAt: 0 };

  it("keeps a fresh token and does not call GitLab", async () => {
    const { refreshed } = await load();
    const f = fakeGitlab(30);
    const t = { ...base, expiresAt: 10 * 60_000 };
    expect(await refreshed(t, 1000, f)).toBe(t);
    expect(f).not.toHaveBeenCalled();
  });

  it("swaps both tokens when the GitLab token is about to end", async () => {
    const { refreshed } = await load();
    const t = await refreshed({ ...base, expiresAt: 1000 }, 1000, fakeGitlab(30));
    expect(t).toMatchObject({ accessToken: "new-at", refreshToken: "new-rt", expiresAt: 1000 + 7200_000 });
  });

  it("marks the token failed when GitLab refuses the refresh", async () => {
    const { refreshed } = await load();
    const f = vi.fn(async () => new Response("no", { status: 400 })) as unknown as typeof fetch;
    expect(await refreshed({ ...base, expiresAt: 1000 }, 1000, f)).toMatchObject({ error: "RefreshFailed" });
  });

  it("ends the session 8 h after sign-in even if it was used since", async () => {
    const { refreshed } = await load();
    expect(await refreshed({ ...base, expiresAt: 9e12 }, 8 * 3_600_000 + 1)).toBeNull();
  });
});

describe("Auth.js wiring", () => {
  it("sends the user to GitLab with read_api, a PKCE challenge and a state", async () => {
    const { handlers } = await load();
    const origin = "https://dash.test";
    const csrf = await handlers.GET(new Request(`${origin}/api/auth/csrf`) as never);
    const { csrfToken } = (await csrf.json()) as { csrfToken: string };
    const cookie = csrf.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const res = await handlers.POST(
      new Request(`${origin}/api/auth/signin/gitlab`, {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrfToken }),
      }) as never,
    );
    const to = new URL(res.headers.get("location") ?? "");
    expect(`${to.origin}${to.pathname}`).toBe("https://gitlab.test/oauth/authorize");
    expect(to.searchParams.get("scope")).toBe("read_api");
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    expect(to.searchParams.get("code_challenge")).toBeTruthy();
    expect(to.searchParams.get("state")).toBeTruthy();
  });

  it("never reaches GitLab for a callback with a state it did not issue", async () => {
    const { handlers } = await load();
    const f = fakeGitlab(30);
    vi.stubGlobal("fetch", f);
    const res = await handlers.GET(new Request("https://dash.test/api/auth/callback/gitlab?code=x&state=wrong") as never);
    vi.unstubAllGlobals();
    expect(f).not.toHaveBeenCalled();
    // Auth.js answers a bad state with a redirect to the error page, not a 400.
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/sign-in?error=");
    expect(res.headers.get("set-cookie") ?? "").not.toContain("session-token");
  });
});
