// The dashboard's GitHub reads, with the server's GITHUB_READ_TOKEN: a user's role.
import type { TargetInfo } from "./targets";

type FetchFn = typeof fetch;

export function makeGitHub(fetchFn: FetchFn = fetch) {
  const headers = () => ({ Authorization: `Bearer ${process.env.GITHUB_READ_TOKEN ?? ""}`, Accept: "application/vnd.github+json" });
  const rest = async (path: string) => {
    const r = await fetchFn(`https://api.github.com${path}`, { headers: headers() });
    if (!r.ok) throw new Error(`GitHub ${r.status} for ${path.split("?")[0]}`);
    return r.json();
  };

  return {
    // Write, maintain or admin on any GitHub target's repo. False when GitHub says no or does not answer.
    async canWrite(login: string, targets: TargetInfo[]): Promise<boolean> {
      for (const t of targets.filter((x) => x.githubRepo)) {
        const p = await rest(`/repos/${t.githubRepo}/collaborators/${encodeURIComponent(login)}/permission`).catch(() => undefined);
        if (p?.permission === "admin" || p?.permission === "write") return true; // maintain shows as write
      }
      return false;
    },
  };
}
