import { AI_LINE, GitLab, GITLAB_URL } from "../gitlab";
import { gitRepo } from "../repo";
import { changeBranchPrefix, type Checks, type CodeHost } from "../seams";

export function makeGitLabCodeHost(gitlab: GitLab, projectPath: string, token: string, env: NodeJS.ProcessEnv, baseBranch: string, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): CodeHost {
  let project: Promise<{ id: number }> | undefined;
  const proj = () => (project ??= gitlab.getProject(projectPath));
  const projectId = async () => (await proj()).id;
  const mrUrl = async (ref: string) => `/projects/${await projectId()}/merge_requests/${Number(ref)}`;
  const opened = (m: { iid: number; webUrl: string }) => ({ ref: String(m.iid), url: m.webUrl });
  const put = async (endpoint: string, body?: unknown) => gitlab.call("PUT", endpoint, body);

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
        // Branch-ref queries miss merge request pipelines, so read the MR's own list (newest first).
        // Only a pipeline for the head counts: a green pipeline of an older commit says nothing about this one.
        const newest = (await gitlab.getJson(`${await mrUrl(at.change)}/pipelines`))[0];
        if (newest?.sha !== at.sha) return "running";
        return newest.status === "success" ? "green" : newest.status === "failed" || newest.status === "canceled" ? "red" : "running";
      }
      // A canceled or skipped pipeline will never give a result. No pipeline yet is running.
      const s = (await gitlab.getJson(`/projects/${id}/pipelines?ref=${encodeURIComponent(at.branch)}&sha=${at.sha}&per_page=1`))[0]?.status;
      return s === "success" ? "green" : s === "failed" ? "red" : s === "canceled" || s === "skipped" ? "none" : "running";
    },
    // Merges now and returns the commit on the target branch. Always squashes, with message as the commit message.
    // With the fast-forward merge method, the squash commit is the only commit that lands.
    // sha is the reviewed head: GitLab refuses the merge if the branch moved since.
    async merge(ref, sha, message) {
      const mr = await (await put(`${await mrUrl(ref)}/merge`, { sha, squash: true, squash_commit_message: message })).json();
      return (mr.merge_commit_sha ?? mr.squash_commit_sha ?? mr.sha) as string;
    },
    async rebase(ref) {
      // GitLab updates the MR's sha in a later job, after rebase_in_progress ends. Apply rebases only a branch
      // that is behind, so the sha must change: wait until it leaves the head from before the rebase.
      const before = (await gitlab.getJson(await mrUrl(ref))).sha;
      try {
        await put(`${await mrUrl(ref)}/rebase`); // runs in the background: the MR shows rebase_in_progress
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
    async readFile(path) {
      return gitlab.fileRaw(await projectId(), path, baseBranch);
    },
    async branchDiff(sha) {
      const c = await gitlab.getJson(`/projects/${await projectId()}/repository/compare?from=${encodeURIComponent(baseBranch)}&to=${sha}`);
      const diffs: { new_path: string; diff: string; too_large?: boolean; collapsed?: boolean }[] = c.diffs;
      // A cut-off diff would read as fewer changed lines.
      if (c.compare_timeout || diffs.some((d) => d.too_large || d.collapsed)) throw new Error(`The diff of ${sha} is cut off, so the factory cannot compare it`);
      return Object.fromEntries(diffs.map((d) => [d.new_path, d.diff]));
    },
    // Every factory change says `Closes #<ticket>`, so the issue lists its changes.
    async changeOfTicket(ticket) {
      const mrs: any[] = await gitlab.getJson(`/projects/${await projectId()}/issues/${Number(ticket)}/related_merge_requests`);
      const m = mrs.filter((x) => String(x.source_branch).startsWith(changeBranchPrefix(ticket))).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
      return m && { ref: String(m.iid), open: m.state === "opened", merged: m.state === "merged", url: m.web_url as string };
    },
    async revert(sha) {
      return opened(await gitlab.revertMerge(await projectId(), sha, baseBranch));
    },
    async commentChange(ref, text) {
      await gitlab.commentMergeRequest(await projectId(), Number(ref), text);
    },
    async assignChange(ref, person) {
      await put(await mrUrl(ref), { assignee_ids: [await gitlab.userId(person)] });
    },
    // The returned url works in the Markdown of a change of this project.
    async attach(name, data) {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(data)], { type: "image/png" }), name);
      return (await (await gitlab.call("POST", `/projects/${await projectId()}/uploads`, form)).json()).url as string;
    },
    async closeChange(ref) {
      await put(await mrUrl(ref), { state_event: "close" });
    },
  };
}
