import { createHash, timingSafeEqual } from "node:crypto";
import NextAuth from "next-auth";
import { getToken } from "next-auth/jwt";
import GitLab from "next-auth/providers/gitlab";
import { gitlab } from "./gitlab";

// Hash both sides so the compare has equal lengths and the token length does not leak.
const digest = (s: string) => createHash("sha256").update(s).digest();

export function factoryAuthorized(req: Request): boolean {
  const token = process.env.FACTORY_DASHBOARD_TOKEN;
  if (!token) return false;
  const given = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  return given !== undefined && timingSafeEqual(digest(given), digest(token));
}

// ---- User sign-in (GitLab through Auth.js) ----

export const MIN_LEVEL = 30; // GitLab Developer
export const REFUSAL = "You need the Developer role on the factory project.";
export const SESSION_HOURS = 8;
const HOUR = 3_600_000;

type FetchFn = typeof fetch;
type Role = { user: string; userId: number; level: number };
export type Actor = { accessToken: string; error?: string };
export type AppToken = {
  userId: number;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // ms
  loginAt: number; // ms
  error?: string;
};

// Pin the public origin: Auth.js then ignores the Host header for redirects (and trusts the host because of it).
process.env.AUTH_URL ??= process.env.DASHBOARD_URL;

const api = (path: string) => `${gitlab()}/api/v4${path}`;

// Reads who the token belongs to and their level on the factory project. Undefined on any non-OK answer.
export async function readRole(accessToken: string, fetchFn: FetchFn = fetch): Promise<Role | undefined> {
  const get = (path: string) => fetchFn(api(path), { headers: { authorization: `Bearer ${accessToken}` } });
  const u = await get("/user");
  if (!u.ok) return undefined;
  const { id, username } = (await u.json()) as { id: number; username: string };
  const m = await get(`/projects/${process.env.FACTORY_PROJECT_ID}/members/all/${id}`);
  // GitLab answers 404 for someone who is not a member: that is level 0, not an error.
  if (m.status === 404) return { user: username, userId: id, level: 0 };
  if (!m.ok) return undefined;
  const { access_level } = (await m.json()) as { access_level: number };
  return { user: username, userId: id, level: access_level };
}

// Sign-in check: the role, or the text to show.
export async function checkRole(accessToken: string, fetchFn: FetchFn = fetch): Promise<Role | { refused: string }> {
  const role = await readRole(accessToken, fetchFn).catch(() => undefined);
  if (!role) return { refused: "GitLab did not confirm your role. Try again." };
  return role.level >= MIN_LEVEL ? role : { refused: REFUSAL };
}

// The user in a session, or undefined when there is none or it ended.
export function currentUser(session: { user?: { name?: string | null }; expires: string } | null | undefined, now = Date.now()) {
  if (!session?.user?.name || Date.parse(session.expires) <= now) return undefined;
  return session.user.name;
}

// Re-reads the level with the user's own token, so a role removed in GitLab stops working at once.
export async function canAct(actor: Actor | undefined, fetchFn: FetchFn = fetch): Promise<boolean> {
  if (!actor || actor.error) return false;
  const role = await readRole(actor.accessToken, fetchFn).catch(() => undefined);
  return !!role && role.level >= MIN_LEVEL;
}

// Keeps the token fresh: null after 8 h in total, a new GitLab token when the old one is about to end.
export async function refreshed(token: AppToken, now = Date.now(), fetchFn: FetchFn = fetch): Promise<AppToken | null> {
  if (now - token.loginAt > SESSION_HOURS * HOUR) return null;
  if (now < token.expiresAt - 60_000) return token;
  if (!token.refreshToken) return { ...token, error: "RefreshFailed" };
  try {
    const res = await fetchFn(`${gitlab()}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.refreshToken,
        client_id: process.env.GITLAB_OAUTH_CLIENT_ID ?? "",
        client_secret: process.env.GITLAB_OAUTH_CLIENT_SECRET ?? "",
      }),
    });
    if (!res.ok) return { ...token, error: "RefreshFailed" };
    const r = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    // GitLab rotates the refresh token, so the new one replaces the old one.
    return { ...token, accessToken: r.access_token, refreshToken: r.refresh_token ?? token.refreshToken, expiresAt: now + r.expires_in * 1000, error: undefined };
  } catch {
    return { ...token, error: "RefreshFailed" };
  }
}

// The GitLab token for the request's session cookie. Server only: the client session never carries it.
export async function actor(req: Request): Promise<Actor | undefined> {
  const secureCookie = new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  const t = (await getToken({ req, secret: process.env.AUTH_SECRET, secureCookie })) as Partial<AppToken> | null;
  if (!t?.accessToken || !t.loginAt || Date.now() - t.loginAt > SESSION_HOURS * HOUR) return undefined;
  return { accessToken: t.accessToken, error: t.error };
}

// The token the jwt callback refreshed, per GitLab user id. The session callback fills it on every auth() call.
// Any live token of the same user has the same role, so one entry per user is enough.
const freshTokens = new Map<number, string>();

declare module "next-auth" {
  interface Session {
    userId?: number;
  }
}

export const authConfig = {
  providers: [
    GitLab({
      baseUrl: `${gitlab()}/`,
      clientId: process.env.GITLAB_OAUTH_CLIENT_ID,
      clientSecret: process.env.GITLAB_OAUTH_CLIENT_SECRET,
      authorization: `${gitlab()}/oauth/authorize?scope=read_api`,
      checks: ["pkce", "state"],
    }),
  ],
  session: { strategy: "jwt" as const, maxAge: SESSION_HOURS * 3600 },
  pages: { signIn: "/sign-in", error: "/sign-in" },
  callbacks: {
    async signIn({ account }: { account?: { access_token?: string } | null }) {
      const r = await checkRole(account?.access_token ?? "");
      if (!("refused" in r)) return true;
      return `/sign-in?error=${r.refused === REFUSAL ? "role" : "unconfirmed"}`;
    },
    async jwt({ token, account, profile }: { token: any; account?: any; profile?: any }) {
      if (account) {
        return {
          ...token,
          userId: Number(profile?.id),
          accessToken: account.access_token,
          refreshToken: account.refresh_token,
          expiresAt: (account.expires_at ?? 0) * 1000,
          loginAt: Date.now(),
        };
      }
      return refreshed(token as AppToken);
    },
    // The client sees the name and id only, never a GitLab token. The token stays in this process, see sessionActor.
    async session({ session, token }: { session: any; token: any }) {
      session.userId = token.userId;
      if (token.error) freshTokens.delete(token.userId);
      else freshTokens.set(token.userId, token.accessToken);
      return session;
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

// For control routes (Ruling R13): the user in the session and their refreshed GitLab token. Undefined without a live session.
export async function sessionActor(): Promise<{ user: string; accessToken: string } | undefined> {
  const session = await auth(); // runs the jwt callback, which refreshes an old token
  const accessToken = session?.userId === undefined ? undefined : freshTokens.get(session.userId);
  const user = currentUser(session);
  return user && accessToken ? { user, accessToken } : undefined;
}
