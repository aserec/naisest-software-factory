import GitLab from "next-auth/providers/gitlab";
import type { SessionUser, SignIn } from "../seams";
import { gitlabUrl } from "./gitlab-url";

const MIN_LEVEL = 30; // GitLab Developer

// Sign-in with GitLab: Developer (30) or more on the factory project FACTORY_PROJECT_ID.
export function makeGitLabSignIn(fetchFn: typeof fetch = fetch): SignIn {
  const gitlab = () => gitlabUrl() ?? "";
  const api = (path: string) => `${gitlab()}/api/v4${path}`;

  // Reads a user's level on the factory project with the server's read token (Ruling R22), so the user's own GitLab token
  // is needed only once, at sign-in. A user who is not a member (GitLab answers 404) is level 0. A blocked user counts as 0 too.
  // Undefined on any other non-OK answer.
  async function memberLevel(userId: number): Promise<number | undefined> {
    const m = await fetchFn(api(`/projects/${process.env.FACTORY_PROJECT_ID}/members/all/${userId}`), { headers: { "PRIVATE-TOKEN": process.env.GITLAB_READ_TOKEN ?? "" } });
    if (m.status === 404) return 0;
    if (!m.ok) return undefined;
    const { access_level, state } = (await m.json()) as { access_level: number; state: string };
    return state === "active" ? access_level : 0;
  }

  return {
    id: "gitlab",
    name: "GitLab",
    provider: () =>
      GitLab({
        baseUrl: `${gitlab()}/`,
        clientId: process.env.GITLAB_OAUTH_CLIENT_ID,
        clientSecret: process.env.GITLAB_OAUTH_CLIENT_SECRET,
        authorization: `${gitlab()}/oauth/authorize?scope=read_user`,
        checks: ["pkce", "state"],
      }),
    // Who the user's token belongs to (read_user scope), then their level.
    async check(account) {
      const user = await (async (): Promise<(SessionUser & { level: number }) | undefined> => {
        const u = await fetchFn(api("/user"), { headers: { authorization: `Bearer ${account.access_token ?? ""}` } });
        if (!u.ok) return undefined;
        const { id, username } = (await u.json()) as { id: number; username: string };
        const level = await memberLevel(id);
        return level === undefined ? undefined : { userId: id, username, signIn: "gitlab", level };
      })().catch(() => undefined);
      if (!user) return { refused: "unconfirmed" };
      const { level, ...rest } = user;
      return level >= MIN_LEVEL ? { user: rest } : { refused: "role" };
    },
    // Re-reads the level on every control action, so a role removed in GitLab stops working at once.
    async canAct(user) {
      const level = await memberLevel(user.userId).catch(() => undefined);
      return (level !== undefined && level >= MIN_LEVEL) || { refused: "role" };
    },
    messages: {
      role: "You need the Developer role on the factory project.",
      unconfirmed: "GitLab did not confirm your role. Try again.",
    },
  };
}
