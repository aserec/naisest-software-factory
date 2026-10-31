import { AI_LINE, GitLab, GITLAB_URL } from "../gitlab";
import { gitRepo } from "../steps/repo";
import type { Checks, CodeHost } from "../seams";

export function makeGitLabCodeHost(gitlab: GitLab, projectPath: string, token: string, env: NodeJS.ProcessEnv, baseBranch: string): CodeHost {
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
      const m = await gitlab.getJson(await mrUrl(ref));
      return {
        ref, open: m.state === "opened", merged: m.state === "merged", head: m.sha, url: m.web_url, body: m.description ?? "",
        landedSha: m.merge_commit_sha ?? m.squash_commit_sha ?? m.sha,
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
    async merge(ref, sha) {
      return gitlab.merge(await projectId(), Number(ref), sha);
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
