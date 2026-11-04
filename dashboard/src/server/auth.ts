import { createHash, timingSafeEqual } from "node:crypto";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import type { SessionUser } from "./seams";
import { signIns } from "./sign-ins";

// Hash both sides so the compare has equal lengths and the token length does not leak.
const digest = (s: string) => createHash("sha256").update(s).digest();

// FACTORY_DISPATCH_TOKEN only sends dispatches, so outside systems get it, never the factory's own token.
export function factoryAuthorized(req: Request, tokenEnv: "FACTORY_DASHBOARD_TOKEN" | "FACTORY_DISPATCH_TOKEN" = "FACTORY_DASHBOARD_TOKEN"): boolean {
  const token = process.env[tokenEnv];
  if (!token) return false;
  const given = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  return given !== undefined && timingSafeEqual(digest(given), digest(token));
}

// ---- User sign-in (the sign-ins compose turns on, through Auth.js) ----

export const SESSION_HOURS = 8;
const HOUR = 3_600_000;

// Pin the public origin: Auth.js then ignores the Host header for redirects (and trusts the host because of it).
if (process.env.DASHBOARD_URL) process.env.AUTH_URL ??= process.env.DASHBOARD_URL;

// Local testing without an OAuth app: AUTH_DEV_LOGIN=1 adds a one-click "dev" user. Never on in production.
export const DEV_LOGIN = process.env.AUTH_DEV_LOGIN === "1" && process.env.NODE_ENV !== "production";
const DEV_USER = { id: "-1", name: "dev" };

declare module "next-auth" {
  interface Session {
    userId?: number;
    username?: string;
    signIn?: string;
  }
}

export const authConfig = {
  providers: [
    ...signIns().map((s) => s.provider()),
    ...(DEV_LOGIN ? [Credentials({ id: "dev", name: "Dev", credentials: {}, authorize: () => DEV_USER })] : []),
  ],
  session: { strategy: "jwt" as const, maxAge: SESSION_HOURS * 3600 },
  pages: { signIn: "/sign-in", error: "/sign-in" },
  callbacks: {
    // A refusal goes to /sign-in?error=<sign-in id>.<key>, and the page shows that sign-in's message for the key.
    async signIn({ account, profile }: { account?: { provider?: string; access_token?: string } | null; profile?: any }) {
      if (DEV_LOGIN && account?.provider === "dev") return true;
      const s = signIns().find((x) => x.id === account?.provider);
      if (!s || !account) return false;
      const r = await s.check(account, profile);
      return "refused" in r ? `/sign-in?error=${s.id}.${r.refused}` : true;
    },
    // The cookie keeps the user id, the username, the sign-in used and the sign-in time only. No access token is kept.
    // The session ends 8 h after sign-in, even if it was used since.
    async jwt({ token, account, profile }: { token: any; account?: any; profile?: any }) {
      if (account?.provider === "dev") profile = { id: DEV_USER.id, username: DEV_USER.name };
      // GitLab names the user `username`, GitHub `login`.
      if (account) return { userId: Number(profile?.id), username: String(profile?.username ?? profile?.login), signIn: String(account.provider), loginAt: Date.now() };
      if (!token.username || !token.loginAt || Date.now() - token.loginAt > SESSION_HOURS * HOUR) return null;
      return token;
    },
    async session({ session, token }: { session: any; token: any }) {
      session.userId = token.userId;
      session.username = token.username;
      // A token from before the sign-in seam has `provider: "github"` for GitHub and nothing for GitLab.
      session.signIn = token.signIn ?? (token.provider === "github" ? "github" : "gitlab");
      session.user = { name: token.username };
      return session;
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

// The user in the request's session, or undefined without a live session.
export async function sessionUser(): Promise<SessionUser | undefined> {
  const s = await auth();
  if (s?.userId === undefined || !s.username || !s.signIn) return undefined;
  return { userId: s.userId, username: s.username, signIn: s.signIn };
}
