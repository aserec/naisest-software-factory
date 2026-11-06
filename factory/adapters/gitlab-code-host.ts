import { setTimeout as wait } from "node:timers/promises";
import { isNotFound } from "../errors";
import { AI_LINE, noQuickActions } from "../conversation";
import { GitLab, GITLAB_URL, refuseSecrets } from "../gitlab";
import { FACTORY_GIT_EMAIL, gitRepo } from "../repo";
import { changeBranchPrefix, ticketOfBranch, type Checks, type CodeHost } from "../seams";

export function makeGitLabCodeHost(gitlab: GitLab, projectPath: string, token: string, env: NodeJS.ProcessEnv, baseBranch: string, sleep: (ms: number) => Promise<unknown> = wait): CodeHost {
  let project: Promise<number> | undefined;
  const projectId = () => (project ??= gitlab.getJson(`/projects/${encodeURIComponent(projectPath)}`).then((p: { id: number }) => p.id));
  const mrUrl = async (ref: string) => `/projects/${await projectId()}/merge_requests/${Number(ref)}`;
  const opened = (m: { iid: number; web_url: string }) => ({ ref: String(m.iid), url: m.web_url });
  let bot: Promise<string> | undefined;
  const botName = () => (bot ??= gitlab.getJson("/user").then((u: { username: string }) => u.username));
  const notesOf = async (ref: string): Promise<any[]> => gitlab.getJson(`${await mrUrl(ref)}/notes?sort=desc&order_by=created_at&per_page=100`);
  const put = async (endpoint: string, body?: unknown) => gitlab.call("PUT", endpoint, body);
  const userId = async (username: string): Promise<number> => {
    const list = await gitlab.getJson(`/users?username=${encodeURIComponent(username)}`);
    if (!list[0]) throw new Error(`GitLab user ${username} not found`);
    return list[0].id;
  };
  const openMergeRequest = async (projectId: number, branch: string, target: string, title: string, description: string) => {
    const mr = await (await gitlab.call("POST", `/projects/${projectId}/merge_requests`, { source_branch: branch, target_branch: target, title, description: noQuickActions(description) })).json();
    return opened(mr);
  };

  return {
    baseBranch: async () => baseBranch,
    cloneAt: (dir) => gitRepo(dir, `${dir}.git`, `${GITLAB_URL}/${projectPath}.git`, token, env),
    async openChange(branch, title, body, ticket) {
      const text = [AI_LINE, ...(ticket ? [`Closes #${ticket}`] : []), body].join("\n\n");
      const id = await projectId();
      // A re-run reuses the open MR of the factory branch and updates its text.
      const open = await gitlab.getJson(`/projects/${id}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}`);
      if (!open[0]) return openMergeRequest(id, branch, baseBranch, title, text);
      // GitLab allows one open MR per source branch, so an MR with another target must be closed by a person.
      if (open[0].target_branch !== baseBranch) throw new Error(`Merge request !${open[0].iid} from ${branch} targets ${open[0].target_branch}, not ${baseBranch}`);
      await put(`/projects/${id}/merge_requests/${open[0].iid}`, { title, description: noQuickActions(text) });
      return opened(open[0]);
    },
    async change(ref) {
      const m = await gitlab.getJson(`${await mrUrl(ref)}?include_diverged_commits_count=true`);
      return {
        ref, open: m.state === "opened", merged: m.state === "merged", mergedAt: m.merged_at ?? undefined, head: m.sha, url: m.web_url, title: m.title ?? "", body: m.description ?? "", target: m.target_branch,
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
      try {
        return await (await gitlab.call("GET", `/projects/${await projectId()}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(baseBranch)}`)).text();
      } catch (e) {
        if (isNotFound(e)) return undefined;
        throw e;
      }
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
      const id = await projectId();
      const mrs: any[] = await gitlab.getJson(`/projects/${id}/issues/${Number(ticket)}/related_merge_requests?per_page=100`);
      // A merge request from a fork can carry the same branch name, so its source project must be ours.
      const m = mrs.filter((x) => String(x.source_branch).startsWith(changeBranchPrefix(ticket)) && x.source_project_id === id).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
      // locked: GitLab sets it while a merge is in flight, so the change is not closed
      return m && { ref: String(m.iid), open: m.state === "opened" || m.state === "locked", merged: m.state === "merged", url: m.web_url as string };
    },
    async revert(sha) {
      const id = await projectId();
      // A unique name, so an earlier revert branch for the same commit does not get in the way.
      const branch = `factory/revert-${sha.slice(0, 8)}-${Date.now()}`;
      await gitlab.call("POST", `/projects/${id}/repository/branches`, { branch, ref: baseBranch });
      await gitlab.call("POST", `/projects/${id}/repository/commits/${sha}/revert`, { branch });
      return openMergeRequest(id, branch, baseBranch, `Revert ${sha.slice(0, 8)}`, `The ${baseBranch} pipeline failed after ${sha}. This reverts it.`);
    },
    async commentChange(ref, text) {
      const body = noQuickActions(`${AI_LINE}\n\n${text}`);
      refuseSecrets(body, "Comment");
      await gitlab.call("POST", `${await mrUrl(ref)}/notes`, { body });
    },
    async changeComments(ref, since) {
      const name = await botName();
      const notes = await notesOf(ref);
      return notes
        .filter((n: any) => !n.system && (!since || Date.parse(n.created_at) > Date.parse(since)))
        .map((n: any) => ({ author: n.author.username, byFactory: n.author.username === name, body: n.body, at: n.created_at }));
    },
    // GitLab writes an edit as a system note: "changed title from ..." or "changed the description".
    // ponytail: edits among the newest 100 notes; page notesOf if a change gets more
    async changeEdits(ref, since) {
      const name = await botName();
      return (await notesOf(ref)).flatMap((n: any) => {
        const field = n.system ? (String(n.body).startsWith("changed title") ? "title" : String(n.body).startsWith("changed the description") ? "body" : undefined) : undefined;
        return field && (!since || Date.parse(n.created_at) > Date.parse(since)) ? [{ author: n.author.username, byFactory: n.author.username === name, field, at: n.created_at }] : [];
      });
    },
    async changeCommits(ref) {
      const commits = await gitlab.all(`${await mrUrl(ref)}/commits?per_page=100`);
      return commits.map((c) => ({ sha: c.id, byFactory: c.author_email === FACTORY_GIT_EMAIL }));
    },
    // Every revert that reached the base branch is a commit here: a revert commit, a merged revert change, or a Revert button.
    async baseCommits(since) {
      const commits = await gitlab.all(`/projects/${await projectId()}/repository/commits?ref_name=${encodeURIComponent(baseBranch)}&since=${encodeURIComponent(since)}&per_page=100`);
      return commits.map((c) => ({ sha: c.id, title: c.title, message: c.message, at: c.committed_date }));
    },
    async recentChanges(since) {
      const id = await projectId();
      const mrs: any[] = await gitlab.getJson(`/projects/${id}/merge_requests?state=opened&updated_after=${encodeURIComponent(since)}&order_by=updated_at&sort=desc&per_page=100`);
      // A merge request from a fork can carry a factory branch name, so its source project must be ours.
      return mrs.flatMap((x) => {
        const ticket = ticketOfBranch(String(x.source_branch));
        return ticket && x.source_project_id === id ? [{ ref: String(x.iid), ticket }] : [];
      });
    },
    async assignChange(ref, person) {
      await put(await mrUrl(ref), { assignee_ids: [await userId(person)] });
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
