// Changes are GitHub pull requests. Checks are the commit's check runs and commit statuses (GitHub Actions and others).
import { AI_LINE, noQuickActions } from "../gitlab";
import type { GitHub } from "../github";
import { gitRepo } from "../repo";
import { findSecrets } from "../rules";
import { changeBranchPrefix, ticketOfBranch, type Checks, type CodeHost } from "../seams";

const ASSETS = "factory-assets"; // the branch that holds attached images, so they never enter a change

export function makeGitHubCodeHost(gh: GitHub, repo: string, token: string, env: NodeJS.ProcessEnv, baseBranch: string, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): CodeHost {
  const r = `/repos/${repo}`;
  const pr = (ref: string) => `${r}/pulls/${Number(ref)}`;
  let bot: Promise<string> | undefined;
  const botName = () => (bot ??= gh.json("GET", "/user").then((u) => u.login as string));
  const opened = (p: any) => ({ ref: String(p.number), url: p.html_url as string });
  const head = async (ref: string) => (await gh.json("GET", pr(ref))).head.sha as string;
  const branchSha = async (branch: string) => (await gh.json("GET", `${r}/git/ref/heads/${branch}`)).object.sha as string;
  const newBranch = (branch: string, sha: string) => gh.json("POST", `${r}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  const openPr = async (branch: string, title: string, body: string) => opened(await gh.json("POST", `${r}/pulls`, { title, head: branch, base: baseBranch, body: noQuickActions(body) }));

  return {
    baseBranch: async () => baseBranch,
    cloneAt: (dir) => gitRepo(dir, `${dir}.git`, `https://github.com/${repo}.git`, token, env),
    // A re-run reuses the open pull request of the factory branch and updates its text.
    async openChange(branch, title, body, ticket) {
      const text = [AI_LINE, `Closes #${ticket}`, body].join("\n\n");
      const [open] = await gh.json("GET", `${r}/pulls?state=open&head=${encodeURIComponent(`${repo.split("/")[0]}:${branch}`)}`);
      if (!open) return openPr(branch, title, text);
      if (open.base.ref !== baseBranch) throw new Error(`Pull request #${open.number} from ${branch} targets ${open.base.ref}, not ${baseBranch}`);
      return opened(await gh.json("PATCH", pr(open.number), { title, body: noQuickActions(text) }));
    },
    async change(ref) {
      const p = await gh.json("GET", pr(ref));
      const cmp = await gh.json("GET", `${r}/compare/${encodeURIComponent(p.base.ref)}...${p.head.sha}`);
      return {
        ref, open: p.state === "open", merged: !!p.merged, head: p.head.sha, url: p.html_url, body: p.body ?? "", target: p.base.ref,
        landedSha: p.merge_commit_sha ?? p.head.sha, behind: cmp.behind_by > 0,
      };
    },
    // Only checks of the head count. No check yet is running, as on GitLab: waitFor gives up after an hour.
    async checks(at): Promise<Checks> {
      if ("change" in at && (await head(at.change)) !== at.sha) return "running";
      const runs: any[] = (await gh.json("GET", `${r}/commits/${at.sha}/check-runs?per_page=100`)).check_runs;
      const statuses: any[] = (await gh.json("GET", `${r}/commits/${at.sha}/status`)).statuses;
      const results = [...runs.map((c) => (c.status === "completed" ? c.conclusion : "pending")), ...statuses.map((s) => s.state)];
      if (results.some((s) => ["failure", "error", "timed_out", "action_required"].includes(s))) return "red";
      // A canceled main pipeline gives no result; a canceled change pipeline is red, as on GitLab.
      if (results.includes("cancelled")) return "change" in at ? "red" : "none";
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
        if (String(e).includes("failed with status 404")) return undefined;
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
    // Without a shared account the code host cannot tell the factory's comments from its token user's own, so it asks for both: the token user and the AI line.
    async changeComments(ref, since) {
      const name = await botName();
      // GitHub's since filters on the edit time; keep only comments created after it, newest first.
      const all = await gh.all(`${r}/issues/${Number(ref)}/comments?per_page=100${since ? `&since=${encodeURIComponent(since)}` : ""}`);
      return all
        .filter((c) => !since || Date.parse(c.created_at) > Date.parse(since))
        .reverse()
        .map((c) => ({ author: c.user.login, byFactory: c.user.login === name && String(c.body ?? "").startsWith(AI_LINE), body: c.body ?? "", at: c.created_at }));
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
        if (!String(e).includes("status 404")) throw e;
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
