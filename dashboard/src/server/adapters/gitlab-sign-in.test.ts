import { beforeEach, describe, expect, it, vi } from "vitest";
import { signInContract } from "../contracts/sign-in.contract";
import { makeGitLabSignIn } from "./gitlab-sign-in";

beforeEach(() => {
  vi.stubEnv("FACTORY_PROJECT_ID", "42");
  vi.stubEnv("GITLAB_URL", "https://gitlab.test");
  vi.stubEnv("GITLAB_READ_TOKEN", "read-token");
});

type Member = number | { status: number } | { level: number; state: string };

// A fake GitLab: /user answers only the user's token, the member read answers only the server's read token.
function fakeGitlab(member: Member | (() => Member)) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const h = new Headers(init?.headers);
    if (u.endsWith("/api/v4/user")) return h.get("authorization") === "Bearer user-token" ? Response.json({ id: 7, username: "dev" }) : new Response("no", { status: 401 });
    if (u.endsWith("/projects/42/members/all/7")) {
      if (h.get("private-token") !== "read-token" || h.has("authorization")) return new Response("no", { status: 401 });
      const m = typeof member === "function" ? member() : member;
      if (typeof m === "number") return Response.json({ access_level: m, state: "active" });
      return "status" in m ? new Response("no", { status: m.status }) : Response.json({ access_level: m.level, state: m.state });
    }
    return new Response("?", { status: 404 });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const down = vi.fn(async () => {
  throw new Error("network");
}) as unknown as typeof fetch;
const account = { access_token: "user-token" };
const user = { userId: 7, username: "dev", signIn: "gitlab" };

signInContract("GitLab", () => {
  let level = 30;
  return { signIn: makeGitLabSignIn(fakeGitlab(() => level)), account, profile: { id: 7, username: "dev" }, allow: (ok) => void (level = ok ? 30 : 20) };
});

describe("sign-in role check", () => {
  it("accepts a Developer (30), reading the member with the read token", async () => {
    expect(await makeGitLabSignIn(fakeGitlab(30)).check(account, {})).toEqual({ user });
  });

  it("refuses a Reporter (20), a non-member (404) and a blocked Developer with the exact text", async () => {
    for (const m of [20, { status: 404 }, { level: 30, state: "blocked" }]) {
      const s = makeGitLabSignIn(fakeGitlab(m));
      expect(await s.check(account, {})).toEqual({ refused: "role" });
      expect(s.messages.role).toBe("You need the Developer role on the factory project.");
    }
  });

  it("says GitLab did not confirm the role on a 500, a thrown error, or a refused user token", async () => {
    for (const [token, f] of [["user-token", fakeGitlab({ status: 500 })], ["user-token", down], ["wrong", fakeGitlab(30)]] as const) {
      const s = makeGitLabSignIn(f);
      expect(await s.check({ access_token: token }, {})).toEqual({ refused: "unconfirmed" });
      expect(s.messages.unconfirmed).toBe("GitLab did not confirm your role. Try again.");
    }
  });
});

describe("canAct", () => {
  it("is true at 30 and active, read with the server's read token", async () => {
    const f = fakeGitlab(30);
    expect(await makeGitLabSignIn(f).canAct(user)).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("refuses at 20, on a 404, for a blocked user, on a non-OK answer and on a thrown error", async () => {
    for (const f of [fakeGitlab(20), fakeGitlab({ status: 404 }), fakeGitlab({ level: 40, state: "blocked" }), fakeGitlab({ status: 500 }), down]) expect(await makeGitLabSignIn(f).canAct(user)).toEqual({ refused: "role" });
  });
});
