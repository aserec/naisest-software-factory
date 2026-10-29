import { DEVELOPER } from "../event";
import { AI_LINE, GitLab } from "../gitlab";
import { gitRepo } from "../steps/repo";
import type { Checks, CodeHost } from "../seams";
import { GITLAB_URL } from "./gitlab-ci";

export function makeGitLabCodeHost(gitlab: GitLab, projectPath: string, token: string, env: NodeJS.ProcessEnv): CodeHost {
  let project: Promise<{ id: number; defaultBranch: string }> | undefined;
  const proj = () => (project ??= gitlab.getProject(projectPath));
  const projectId = async () => (await proj()).id;
  const mrUrl = async (ref: string) => `/projects/${await projectId()}/merge_requests/${Number(ref)}`;
  const opened = (m: { iid: number; webUrl: string }) => ({ ref: String(m.iid), url: m.webUrl });

  return {
    defaultBranch: async () => (await proj()).defaultBranch,
    cloneAt: (dir) => gitRepo(dir, `${dir}.git`, `${GITLAB_URL}/${projectPath}.git`, token, env),
    async openChange(branch, title, body, ticket) {
      const text = [AI_LINE, `Closes #${ticket}`, body].join("\n\n");
      const { id, defaultBranch } = await proj();
      return opened(await gitlab.upsertMergeRequest(id, branch, defaultBranch, title, text));
    },
    async change(ref) {
      const m = await gitlab.getJson(await mrUrl(ref));
      return {
        ref, open: m.state === "opened", merged: m.state === "merged", head: m.sha, url: m.web_url, body: m.description ?? "",
        landedSha: m.merge_commit_sha ?? m.squash_commit_sha ?? m.sha,
      };
    },
    // Someone other than the bot, with the Developer role or higher.
    async approvedByTrusted(ref) {
      const id = await projectId();
      const bot = await gitlab.botUserId();
      for (const approver of await gitlab.approvedBy(id, Number(ref))) {
        if (approver !== bot && (await gitlab.memberAccessLevel(id, approver)) >= DEVELOPER) return true;
      }
      return false;
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
      const { id, defaultBranch } = await proj();
      return opened(await gitlab.revertMerge(id, sha, defaultBranch));
    },
    async commentChange(ref, text) {
      await gitlab.commentMergeRequest(await projectId(), Number(ref), text);
    },
    async assignChange(ref, person) {
      await gitlab.assignMergeRequest(await projectId(), Number(ref), await gitlab.userId(person));
    },
  };
}
