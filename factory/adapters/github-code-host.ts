// Changes are GitHub pull requests. Checks are the commit's check runs and commit statuses (GitHub Actions and others).
import { setTimeout as wait } from "node:timers/promises";
import { isNotFound } from "../errors";
import { AI_LINE, noQuickActions } from "../conversation";
import type { GitHub } from "../github";
import { FACTORY_GIT_EMAIL, gitRepo } from "../repo";
import { findSecrets } from "../rules";
import { changeBranchPrefix, ticketOfBranch, type Checks, type CodeHost } from "../seams";

const ASSETS = "factory-assets"; // the branch that holds attached images, so they never enter a change

// The fields of a GitHub commit the factory reads.
type Commit = { sha: string; commit?: { message?: string; author?: { email?: string; date?: string }; committer?: { date?: string } } };
export function makeGitHubCodeHost(gh: GitHub, repo: string, token: string, env: NodeJS.ProcessEnv, baseBranch: string, sleep: (ms: number) => Promise<unknown> = wait): CodeHost {
  const r = `/repos/${repo}`;
  const pr = (ref: string) => `${r}/pulls/${Number(ref)}`;
  const opened = (p: any) => ({ ref: String(p.number), url: p.html_url as string });
  let workflows: Promise<boolean> | undefined;
  const hasWorkflows = () => (workflows ??= gh.json("GET", `${r}/actions/workflows?per_page=100`).then((w) => w.workflows.some((x: any) => x.state === "active"), () => true));
  const head = async (ref: string) => (await gh.json("GET", pr(ref))).head.sha as string;
  const branchSha = async (branch: string) => (await gh.json("GET", `${r}/git/ref/heads/${branch}`)).object.sha as string;
  const newBranch = (branch: string, sha: string) => gh.json("POST", `${r}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  const openPr = async (branch: string, title: string, body: string) => opened(await gh.json("POST", `${r}/pulls`, { title, head: branch, base: baseBranch, body: noQuickActions(body) }));

  return {
    baseBranch: async () => baseBranch,
    cloneAt: (dir) => gitRepo(dir, `${dir}.git`, `https://github.com/${repo}.git`, token, env),
    // A re-run reuses the open pull request of the factory branch and updates its text.
    async openChange(branch, title, body, ticket) {
      const text = [AI_LINE, ...(ticket ? [`Closes #${ticket}`] : []), body].join("\n\n");
      const [open] = await gh.json("GET", `${r}/pulls?state=open&head=${encodeURIComponent(`${repo.split("/")[0]}:${branch}`)}`);
      if (!open) return openPr(branch, title, text);
      if (open.base.ref !== baseBranch) throw new Error(`Pull request #${open.number} from ${branch} targets ${open.base.ref}, not ${baseBranch}`);
      return opened(await gh.json("PATCH", pr(open.number), { title, body: noQuickActions(text) }));
    },
    async change(ref) {
      const p = await gh.json("GET", pr(ref));
      const cmp = await gh.json("GET", `${r}/compare/${encodeURIComponent(p.base.ref)}...${p.head.sha}`);
      return {
        ref, open: p.state === "open", merged: !!p.merged, mergedAt: p.merged_at ?? undefined, head: p.head.sha, url: p.html_url, title: p.title ?? "", body: p.body ?? "", target: p.base.ref,
        landedSha: p.merge_commit_sha ?? p.head.sha, behind: cmp.behind_by > 0,
        // GitHub computes mergeable later and gives null until then: no conflict yet, the next poll reads it again.
        conflicts: p.mergeable === false || p.mergeable_state === "dirty",
        // Only the issue API names who closed a pull request.
        closedBy: p.state === "closed" && !p.merged ? (await gh.json("GET", `${r}/issues/${ref}`)).closed_by?.login : undefined,
      };
    },
    // Only checks of the head count. No check yet is running, as on GitLab: waitFor gives up after an hour.
    async checks(at): Promise<Checks> {
      const p = "change" in at ? await gh.json("GET", pr(at.change)) : undefined;
      if (p && p.head.sha !== at.sha) return "running";
      const runs: any[] = (await gh.json("GET", `${r}/commits/${at.sha}/check-runs?per_page=100`)).check_runs;
      const statuses: any[] = (await gh.json("GET", `${r}/commits/${at.sha}/status`)).statuses;
      const results = [...runs.map((c) => (c.status === "completed" ? c.conclusion : "pending")), ...statuses.map((s) => s.state)];
      if (results.some((s) => ["failure", "error", "timed_out", "action_required"].includes(s))) return "red";
      // A canceled main pipeline gives no result; a canceled change pipeline is red, as on GitLab.
      if (results.includes("cancelled")) return "change" in at ? "red" : "none";
      // A repo with no active Actions workflow gets no check: say so now, not after the hour waitFor would wait.
      // ponytail: an outside app (Vercel and others) that posts statuses late is missed; it counts as no checks.
      if (results.length === 0 && !(await hasWorkflows())) return "absent";
      // GitHub runs no pull request CI while the change conflicts with its base: no result, so a person gets it and a conflict round starts.
      if (results.length === 0 && (p?.mergeable === false || p?.mergeable_state === "dirty")) return "none";
      if (results.length === 0 || results.some((s) => s === "pending" || s === "queued" || s === "in_progress")) return "running";
      return "green";
    },
    // Squashes. sha is the reviewed head: GitHub refuses the merge if the branch moved since.
    async merge(ref, sha, message) {
      const [title, ...rest] = message.split("\n");
      return (await gh.json("PUT", `${pr(ref)}/merge`, { sha, merge_method: "squash", commit_title: title, commit_message: rest.join("\n").trim() })).sha;
    },
    // GitHub's update-branch merges the base into the branch. The squash merge lands one commit all the same,
    // and apply compares the changed lines, which a merge keeps. It runs in the background: wait for a new head.
    async rebase(ref) {
      const before = await head(ref);
      try {
        await gh.json("PUT", `${pr(ref)}/update-branch`, { expected_head_sha: before });
      } catch (e) {
        return { ok: false, error: String(e) };
      }
      for (let i = 0; i < 60; i++) {
        await sleep(5000);
        const now = await head(ref);
        if (now !== before) return { ok: true, head: now };
      }
      return { ok: false, error: "the branch update did not end within 5 minutes" };
    },
    // The raw media type returns the file text itself, not JSON with base64.
    async readFile(path) {
      try {
        const url = `${r}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(baseBranch)}`;
        return await (await gh.call("GET", url, undefined, { Accept: "application/vnd.github.raw" })).text();
      } catch (e) {
        if (isNotFound(e)) return undefined;
        throw e;
      }
    },
    async branchDiff(sha) {
      const c = await gh.json("GET", `${r}/compare/${encodeURIComponent(baseBranch)}...${sha}`);
      const files: { filename: string; patch?: string; changes: number }[] = c.files ?? [];
      // GitHub lists at most 300 files and leaves out the patch of a large file. A binary file has no lines (changes 0).
      if (files.length >= 300 || files.some((f) => f.changes > 0 && f.patch === undefined)) throw new Error(`The diff of ${sha} is cut off, so the factory cannot compare it`);
      return Object.fromEntries(files.map((f) => [f.filename, f.patch ?? ""]));
    },
    // GitHub has no revert endpoint. verify reverts right after the merge, so sha is still the base tip:
    // the revert commit takes the tree of sha's parent.
    // ponytail: a base that moved past sha is left to a person; a git revert in a clone would handle it.
    // A pull request from a fork can carry the same branch name, so the head repo must be ours.
    // ponytail: newest 100 pulls only, page further if a repo opens more between two polls
    async changeOfTicket(ticket) {
      const pulls: any[] = await gh.json("GET", `${r}/pulls?state=all&sort=created&direction=desc&per_page=100`);
      const p = pulls.filter((x) => String(x.head?.ref).startsWith(changeBranchPrefix(ticket)) && String(x.head?.repo?.full_name).toLowerCase() === repo.toLowerCase()).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
      return p && { ref: String(p.number), open: p.state === "open", merged: !!p.merged_at, url: p.html_url as string };
    },
    async revert(sha) {
      if ((await branchSha(baseBranch)) !== sha) throw new Error(`${baseBranch} moved past ${sha.slice(0, 8)}, so the factory cannot revert it. Revert it by hand`);
      const parent = (await gh.json("GET", `${r}/git/commits/${sha}`)).parents[0].sha;
      const tree = (await gh.json("GET", `${r}/git/commits/${parent}`)).tree.sha;
      const commit = await gh.json("POST", `${r}/git/commits`, { message: `Revert ${sha.slice(0, 8)}`, tree, parents: [sha] });
      const branch = `factory/revert-${sha.slice(0, 8)}-${Date.now()}`;
      await newBranch(branch, commit.sha);
      return openPr(branch, `Revert ${sha.slice(0, 8)}`, `The ${baseBranch} checks failed after ${sha}. This reverts it.`);
    },
    async commentChange(ref, text) {
      const body = `${AI_LINE}\n\n${text}`;
      if (findSecrets(body).length > 0) throw new Error("Comment refused: it contains a secret");
      await gh.json("POST", `${r}/issues/${Number(ref)}/comments`, { body });
    },
    // ponytail: review summaries are not read; add pulls/<n>/reviews if people use them
    // ponytail: two paged lists per pull request, and the poller reads every pull request updated in the last 10 minutes.
    // With since both are short. If the rate limit bites, read the repo-wide issues/comments and pulls/comments once per poll.
    // Without a shared account the code host cannot tell the factory's comments from its token user's own, so it asks for both: the token user and the AI line.
    async changeComments(ref, since) {
      const name = await gh.botName();
      // GitHub's since filters on the edit time; keep only comments created after it, newest first.
      // Issue comments and inline review comments are two lists, so merge them by time.
      const q = `?per_page=100${since ? `&since=${encodeURIComponent(since)}` : ""}`;
      type Comment = { user: { login: string }; body: string | null; created_at: string };
      const all = [...(await gh.all<Comment>(`${r}/issues/${Number(ref)}/comments${q}`)), ...(await gh.all<Comment>(`${pr(ref)}/comments${q}`))];
      return all
        .filter((c) => !since || Date.parse(c.created_at) > Date.parse(since))
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
        .map((c) => ({ author: c.user.login, byFactory: c.user.login === name && String(c.body ?? "").startsWith(AI_LINE), body: c.body ?? "", at: c.created_at }));
    },
    // Body edits come from the pull request's edit history, renames from its timeline; both newest first.
    // ponytail: the newest 100 body edits and 100 renames; page with before: if a change is edited more
    async changeEdits(ref, since) {
      const name = await gh.botName();
      const [owner, repoName] = repo.split("/");
      const d = await gh.graphql(
        `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) {
          userContentEdits(last: 100) { nodes { editor { login } editedAt } }
          timelineItems(itemTypes: [RENAMED_TITLE_EVENT], last: 100) { nodes { ... on RenamedTitleEvent { actor { login } createdAt } } }
        } } }`,
        { owner, name: repoName, number: Number(ref) },
      );
      const p = d.repository?.pullRequest;
      if (!p) throw new Error(`Pull request #${ref} not found in ${repo}`);
      const edit = (field: "title" | "body", login: string | undefined, at: string) => ({ author: login ?? "ghost", byFactory: login === name, field, at });
      return [
        ...p.userContentEdits.nodes.map((n: any) => edit("body", n.editor?.login, n.editedAt)),
        ...p.timelineItems.nodes.map((n: any) => edit("title", n.actor?.login, n.createdAt)),
      ]
        .filter((e) => !since || Date.parse(e.at) > Date.parse(since))
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    },
    // GitHub lists at most 250 commits of a pull request.
    async changeCommits(ref) {
      const commits = await gh.all<Commit>(`${pr(ref)}/commits?per_page=100`);
      return commits.map((c) => ({ sha: c.sha, byFactory: c.commit?.author?.email === FACTORY_GIT_EMAIL }));
    },
    // Every revert that reached the base branch is a commit here: a revert commit, a merged revert pull request, or a Revert button.
    async baseCommits(since) {
      const commits = await gh.all<Commit>(`${r}/commits?sha=${encodeURIComponent(baseBranch)}&since=${encodeURIComponent(since)}&per_page=100`);
      return commits.map((c) => {
        const message = String(c.commit?.message ?? "");
        return { sha: c.sha, title: message.split("\n")[0], message, at: c.commit?.committer?.date ?? c.commit?.author?.date ?? "" };
      });
    },
    // ponytail: newest 100 pulls only, as in changeOfTicket
    async recentChanges(since) {
      const pulls: any[] = await gh.json("GET", `${r}/pulls?state=open&sort=updated&direction=desc&per_page=100`);
      return pulls.flatMap((x) => {
        const ticket = ticketOfBranch(String(x.head?.ref));
        return ticket && Date.parse(x.updated_at) > Date.parse(since) && String(x.head?.repo?.full_name).toLowerCase() === repo.toLowerCase() ? [{ ref: String(x.number), ticket }] : [];
      });
    },
    async assignChange(ref, person) {
      await gh.json("POST", `${r}/issues/${Number(ref)}/assignees`, { assignees: [person] });
    },
    // GitHub has no upload API, so the image goes on its own branch. The link opens for anyone who can read the repo.
    async attach(name, data) {
      try {
        await branchSha(ASSETS);
      } catch (e) {
        if (!isNotFound(e)) throw e;
        await newBranch(ASSETS, await branchSha(baseBranch));
      }
      const path = `${ASSETS}/${Date.now()}-${name.replace(/[^\w.-]/g, "_")}`;
      await gh.json("PUT", `${r}/contents/${path}`, { message: `factory: attach ${name}`, content: data.toString("base64"), branch: ASSETS });
      return `https://github.com/${repo}/blob/${ASSETS}/${path}?raw=true`;
    },
    async closeChange(ref) {
      await gh.json("PATCH", pr(ref), { state: "closed" });
    },
  };
}
