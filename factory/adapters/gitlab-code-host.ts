import { AI_LINE, GitLab, GITLAB_URL } from "../gitlab";
import { gitRepo } from "../steps/repo";
import type { Checks, CodeHost } from "../seams";

export function makeGitLabCodeHost(gitlab: GitLab, projectPath: string, token: string, env: NodeJS.ProcessEnv, baseBranch: string, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): CodeHost {
  let project: Promise<{ id: number }> | undefined;
  const proj = () => (project ??= gitlab.getProject(projectPath));
  const projectId = async () => (await proj()).id;
  const mrUrl = async (ref: string) => `/projects/${await projectId()}/merge_requests/${Number(ref)}`;
  const opened = (m: { iid: number; webUrl: string }) => ({ ref: String(m.iid), url: m.webUrl });

  return {
    baseBranch: async () => baseBranch,
    cloneAt: (dir) => gitRepo(dir, `${dir}.git`, `${GITLAB_URL}/${projectPath}.git`, token, env),
    async openChange(branch, title, body, ticket) {
      const text = [AI_LINE, `Closes #${ticket}`, body].join("\n\n");
      return opened(await gitlab.upsertMergeRequest(await projectId(), branch, baseBranch, title, text));
    },
    async change(ref) {
      const m = await gitlab.getJson(`${await mrUrl(ref)}?include_diverged_commits_count=true`);
      return {
        ref, open: m.state === "opened", merged: m.state === "merged", head: m.sha, url: m.web_url, body: m.description ?? "", target: m.target_branch,
        landedSha: m.merge_commit_sha ?? m.squash_commit_sha ?? m.sha, behind: (m.diverged_commits_count ?? 0) > 0,
      };
    },
    async checks(at): Promise<Checks> {
      const id = await projectId();
      if ("change" in at) {
        const s = await gitlab.mergeRequestPipelineStatus(id, Number(at.change), at.sha);
        return s === "success" ? "green" : s === "failed" ? "red" : "running";
      }
      const s = await gitlab.pipelineStatus(id, at.branch, at.sha);
      return s === "success" ? "green" : s === "failed" ? "red" : s;
    },
    async merge(ref, sha, message) {
      return gitlab.merge(await projectId(), Number(ref), sha, message);
    },
    async rebase(ref) {
      // GitLab updates the MR's sha in a later job, after rebase_in_progress ends. Apply rebases only a branch
      // that is behind, so the sha must change: wait until it leaves the head from before the rebase.
      const before = (await gitlab.getJson(await mrUrl(ref))).sha;
      try {
        await gitlab.rebaseMergeRequest(await projectId(), Number(ref));
      } catch (e) {
        return { ok: false, error: String(e) };
      }
      for (let i = 0; i < 60; i++) {
        await sleep(5000);
        const m = await gitlab.getJson(`${await mrUrl(ref)}?include_rebase_in_progress=true`);
        if (m.rebase_in_progress) continue;
        if (m.merge_error) return { ok: false, error: m.merge_error };
        if (m.sha !== before) return { ok: true, head: m.sha };
      }
      return { ok: false, error: "the rebase did not end within 5 minutes" };
    },
    async branchDiff(sha) {
      const c = await gitlab.getJson(`/projects/${await projectId()}/repository/compare?from=${encodeURIComponent(baseBranch)}&to=${sha}`);
      const diffs: { new_path: string; diff: string; too_large?: boolean; collapsed?: boolean }[] = c.diffs;
      // A cut-off diff would read as fewer changed lines.
      if (c.compare_timeout || diffs.some((d) => d.too_large || d.collapsed)) throw new Error(`The diff of ${sha} is cut off, so the factory cannot compare it`);
      return Object.fromEntries(diffs.map((d) => [d.new_path, d.diff]));
    },
    async revert(sha) {
      return opened(await gitlab.revertMerge(await projectId(), sha, baseBranch));
    },
    async commentChange(ref, text) {
      await gitlab.commentMergeRequest(await projectId(), Number(ref), text);
    },
    async assignChange(ref, person) {
      await gitlab.assignMergeRequest(await projectId(), Number(ref), await gitlab.userId(person));
    },
    async attach(name, data) {
      return gitlab.uploadFile(await projectId(), name, data);
    },
  };
}
