import { createHash, timingSafeEqual } from "node:crypto";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import GitLab from "next-auth/providers/gitlab";
import { makeGitHub } from "./github";
import { gitlab } from "./gitlab";
import { readTargets } from "./targets";

// Hash both sides so the compare has equal lengths and the token length does not leak.
const digest = (s: string) => createHash("sha256").update(s).digest();

// FACTORY_DISPATCH_TOKEN only sends dispatches, so outside systems get it, never the factory's own token.
export function factoryAuthorized(req: Request, tokenEnv: "FACTORY_DASHBOARD_TOKEN" | "FACTORY_DISPATCH_TOKEN" = "FACTORY_DASHBOARD_TOKEN"): boolean {
  const token = process.env[tokenEnv];
  if (!token) return false;
  const given = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  return given !== undefined && timingSafeEqual(digest(given), digest(token));
}

// ---- User sign-in (GitLab or GitHub through Auth.js) ----
// Each sign-in is on when its OAuth app is set: GitLab for GitLab targets, GitHub for GitHub targets.

export const MIN_LEVEL = 30; // GitLab Developer
export const REFUSAL = "You need the Developer role on the factory project.";
export const GITHUB_REFUSAL = "You need write access to the repo of a GitHub target.";
export const SESSION_HOURS = 8;
const HOUR = 3_600_000;

type FetchFn = typeof fetch;
type Role = { user: string; userId: number; level: number };

// Pin the public origin: Auth.js then ignores the Host header for redirects (and trusts the host because of it).
if (process.env.DASHBOARD_URL) process.env.AUTH_URL ??= process.env.DASHBOARD_URL;

const api = (path: string) => `${gitlab()}/api/v4${path}`;

// Reads a user's level on the factory project with the server's read token (Ruling R22), so the user's own GitLab token
// is needed only once, at sign-in. A user who is not a member (GitLab answers 404) is level 0. A blocked user counts as 0 too.
// Undefined on any other non-OK answer.
async function memberLevel(userId: number, fetchFn: FetchFn): Promise<number | undefined> {
  const m = await fetchFn(api(`/projects/${process.env.FACTORY_PROJECT_ID}/members/all/${userId}`), { headers: { "PRIVATE-TOKEN": process.env.GITLAB_READ_TOKEN ?? "" } });
  if (m.status === 404) return 0;
  if (!m.ok) return undefined;
  const { access_level, state } = (await m.json()) as { access_level: number; state: string };
  return state === "active" ? access_level : 0;
}

// Sign-in check: who the user's token belongs to (read_user scope), then their level. The role, or the text to show.
export async function checkRole(accessToken: string, fetchFn: FetchFn = fetch): Promise<Role | { refused: string }> {
  const role = await (async () => {
    const u = await fetchFn(api("/user"), { headers: { authorization: `Bearer ${accessToken}` } });
    if (!u.ok) return undefined;
    const { id, username } = (await u.json()) as { id: number; username: string };
    const level = await memberLevel(id, fetchFn);
    return level === undefined ? undefined : { user: username, userId: id, level };
  })().catch(() => undefined);
  if (!role) return { refused: "GitLab did not confirm your role. Try again." };
  return role.level >= MIN_LEVEL ? role : { refused: REFUSAL };
}

// Local testing without a GitLab OAuth app: AUTH_DEV_LOGIN=1 adds a one-click "dev" user. Never on in production.
export const DEV_LOGIN = process.env.AUTH_DEV_LOGIN === "1" && process.env.NODE_ENV !== "production";
const DEV_USER = { id: "-1", name: "dev" };

// Re-reads the level on every control action, so a role removed in GitLab stops working at once.
export async function canAct(userId: number, fetchFn: FetchFn = fetch): Promise<boolean> {
  if (DEV_LOGIN && userId === Number(DEV_USER.id)) return true;
  const level = await memberLevel(userId, fetchFn).catch(() => undefined);
  return level !== undefined && level >= MIN_LEVEL;
}

// A GitHub user may act while they have write access to a GitHub target's repo, read again on every action.
export async function canActOnGitHub(login: string, fetchFn: FetchFn = fetch): Promise<boolean> {
  return makeGitHub(fetchFn).canWrite(login, readTargets()).catch(() => false);
}

declare module "next-auth" {
  interface Session {
    userId?: number;
    username?: string;
    provider?: "github";
  }
}

export const GITLAB_LOGIN = !!process.env.GITLAB_OAUTH_CLIENT_ID;
export const GITHUB_LOGIN = !!process.env.GITHUB_OAUTH_CLIENT_ID;

export const authConfig = {
  providers: [
    ...(GITLAB_LOGIN ? [GitLab({
      baseUrl: `${gitlab()}/`,
      clientId: process.env.GITLAB_OAUTH_CLIENT_ID,
      clientSecret: process.env.GITLAB_OAUTH_CLIENT_SECRET,
      authorization: `${gitlab()}/oauth/authorize?scope=read_user`,
      checks: ["pkce", "state"],
    })] : []),
    // No scope: sign-in only reads who the user is. The role comes from the server's GITHUB_READ_TOKEN.
    ...(GITHUB_LOGIN ? [GitHub({
      clientId: process.env.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
      authorization: { params: { scope: "" } },
      checks: ["pkce", "state"],
    })] : []),
    ...(DEV_LOGIN ? [Credentials({ id: "dev", name: "Dev", credentials: {}, authorize: () => DEV_USER })] : []),
  ],
  session: { strategy: "jwt" as const, maxAge: SESSION_HOURS * 3600 },
  pages: { signIn: "/sign-in", error: "/sign-in" },
  callbacks: {
    async signIn({ account, profile }: { account?: { provider?: string; access_token?: string } | null; profile?: any }) {
      if (DEV_LOGIN && account?.provider === "dev") return true;
      if (account?.provider === "github") return (await canActOnGitHub(String(profile?.login ?? ""))) || "/sign-in?error=github-role";
      const r = await checkRole(account?.access_token ?? "");
      if (!("refused" in r)) return true;
      return `/sign-in?error=${r.refused === REFUSAL ? "role" : "unconfirmed"}`;
    },
    // The cookie keeps the GitLab user id, the username and the sign-in time only. No GitLab token is kept.
    // The session ends 8 h after sign-in, even if it was used since.
    async jwt({ token, account, profile }: { token: any; account?: any; profile?: any }) {
      if (account?.provider === "dev") profile = { id: DEV_USER.id, username: DEV_USER.name };
      if (account?.provider === "github") return { userId: Number(profile?.id), username: String(profile?.login), provider: "github", loginAt: Date.now() };
      if (account) return { userId: Number(profile?.id), username: String(profile?.username), loginAt: Date.now() };
      if (!token.username || !token.loginAt || Date.now() - token.loginAt > SESSION_HOURS * HOUR) return null;
      return token;
    },
    async session({ session, token }: { session: any; token: any }) {
      session.userId = token.userId;
      session.username = token.username;
      if (token.provider === "github") session.provider = "github";
      session.user = { name: token.username };
      return session;
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

// The user in the request's session, or undefined without a live session.
export async function sessionUser(): Promise<{ userId: number; username: string; provider?: "github" } | undefined> {
  const s = await auth();
  if (s?.userId === undefined || !s.username) return undefined;
  return { userId: s.userId, username: s.username, ...(s.provider && { provider: s.provider }) };
}
