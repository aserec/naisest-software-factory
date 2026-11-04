import GitHub from "next-auth/providers/github";
import type { SignIn } from "../seams";
import { readTargets } from "../targets";
import { githubApi } from "./github-url";

// Sign-in with GitHub: write, maintain or admin on the repo of any GitHub target, read with the server's GITHUB_READ_TOKEN.
export function makeGitHubSignIn(fetchFn: typeof fetch = fetch): SignIn {
  // False when GitHub says no or does not answer.
  const canWrite = (login: string) => writes(login).catch(() => false);
  async function writes(login: string): Promise<boolean> {
    for (const t of readTargets().filter((x) => x.githubRepo)) {
      const r = await fetchFn(`${githubApi()}/repos/${t.githubRepo}/collaborators/${encodeURIComponent(login)}/permission`, {
        headers: { Authorization: `Bearer ${process.env.GITHUB_READ_TOKEN ?? ""}`, Accept: "application/vnd.github+json" },
      }).catch(() => undefined);
      const p = r?.ok ? ((await r.json().catch(() => undefined)) as { permission?: string } | undefined) : undefined;
      if (p?.permission === "admin" || p?.permission === "write") return true; // maintain shows as write
    }
    return false;
  }
  const refused = { refused: "role" };

  return {
    id: "github",
    name: "GitHub",
    // No scope: sign-in only reads who the user is. The role comes from the server's GITHUB_READ_TOKEN.
    provider: () =>
      GitHub({
        clientId: process.env.GITHUB_OAUTH_CLIENT_ID,
        clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
        authorization: { params: { scope: "" } },
        checks: ["pkce", "state"],
      }),
    async check(_account, profile) {
      const { id, login } = (profile ?? {}) as { id?: number; login?: string };
      if (!login) return refused;
      return (await canWrite(login)) ? { user: { userId: Number(id), username: login, signIn: "github" } } : refused;
    },
    // Read again on every action, so write access removed on GitHub stops working at once.
    canAct: async (user) => (await canWrite(user.username)) || refused,
    messages: { role: "You need write access to the repo of a GitHub target." },
  };
}
