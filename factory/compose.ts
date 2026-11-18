// The composition root: builds the step context from seams.yml. The one place that knows which tool fills each seam.
import { setTimeout as wait } from "node:timers/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeGitLabCi } from "./adapters/gitlab-ci";
import { makeHttpDashboard } from "./adapters/http-dashboard";
import { makeGitLabCodeHost } from "./adapters/gitlab-code-host";
import { makeGitLabTracker } from "./adapters/gitlab-tracker";
import { makeFileLogs } from "./adapters/file-logs";
import { makeModelJudge } from "./adapters/model-judge";
import { HARNESSES } from "./harnesses";
import { makeTeamsChat } from "./adapters/teams-chat";
import { makeSlackChat } from "./adapters/slack-chat";
import { needEnv } from "./ci-vars";
import { checkDashboardUrl, loadRouter, loadSeams, loadTarget, modelChoice, providerKeys, TARGETS_DIR } from "./config";
import { makeLocalCi } from "./adapters/local-ci";
import { makeGitHubTracker } from "./adapters/github-tracker";
import { ownTickets } from "./owner";
import { makeGitHubCodeHost } from "./adapters/github-code-host";
import { GitHub } from "./github";
import { GitLab, GITLAB_URL } from "./gitlab";
import { makeJevClient } from "./jev";
import { newRecord, RUN_DIR } from "./record";
import { addKnownSecrets } from "./rules";
import { ADAPTER_SECRETS, BOT_SECRETS, FILE_SECRETS } from "./secrets";
import type { StepContext } from "./steps/context";
import { FACTORY_ROOT, GITLAB_SECRET_DIR, SECRET_DIR, STATE_DIR } from "./repo";
import type { Chat, CodeHost, Comment, Tracker } from "./seams";
import { asFactoryMention } from "./conversation";
import { errText } from "./errors";
import type { SeamsConfig, Target } from "./types";

// Adapter names in seams.yml, and what each one builds. A new adapter is one line here.
const ADAPTERS = {
  ci: { gitlab: makeGitLabCi, local: makeLocalCi },
  // The github trackers and code host get FACTORY_GITHUB_TOKEN; the gitlab ones get FACTORY_GITLAB_TOKEN.
  tracker: {
    gitlab: (token: string, target: Target) => makeGitLabTracker(new GitLab(GITLAB_URL, token), target.projectPath, target.teamsRelay),
    github: (token: string, target: Target) => makeGitHubTracker(new GitHub(token), needRepo(target), undefined, target.sharedAccount, target.teamsRelay),
    "github-project": (token: string, target: Target) => {
      if (!target.githubProject) throw new Error(`Target ${target.name} needs githubProject for the github-project tracker`);
      return makeGitHubTracker(new GitHub(token), needRepo(target), target.githubProject, target.sharedAccount, target.teamsRelay);
    },
  },
  codeHost: {
    gitlab: (token: string, target: Target, env: NodeJS.ProcessEnv, email?: string) => makeGitLabCodeHost(new GitLab(GITLAB_URL, token), target.projectPath, token, env, target.baseBranch, undefined, email),
    github: (token: string, target: Target, env: NodeJS.ProcessEnv, email?: string) => makeGitHubCodeHost(new GitHub(token), needRepo(target), token, env, target.baseBranch, undefined, email),
  },
  judge: {
    "jev-celeris": (env: NodeJS.ProcessEnv) => makeJevClient(env),
    "model-call": (env: NodeJS.ProcessEnv, seams: SeamsConfig) => makeModelJudge(modelChoice(seams.judgeModel, seams), env),
  },
  chat: {
    teams: makeTeamsChat,
    slack: makeSlackChat,
    // Local trials: notices go to the job log.
    console: (): Chat => ({ notify: async (kind, title, lines, url) => console.log(`[chat ${kind}] ${title}\n${lines.join("\n")}\n${url}`) }),
  },
  dashboard: { http: makeHttpDashboard },
  // The watcher's rules depend on the exact name "files": fake errors from this checkout.
  logSource: { files: () => makeFileLogs(resolve(FACTORY_ROOT, "watcher/fixtures")) },
};
// Every tracker, code host and chat adapter reads its secret from secrets.ts; only chat console has none.
for (const seam of ["tracker", "codeHost", "chat"] as const)
  for (const n of Object.keys(ADAPTERS[seam])) if (!(n in ADAPTER_SECRETS[seam]) && n !== "console") throw new Error(`secrets.ts names no secret for ${seam} adapter ${n}`);
function needRepo(target: Target): string {
  if (!target.githubRepo) throw new Error(`Target ${target.name} needs githubRepo for a github tracker or code host`);
  return target.githubRepo;
}
type Seam = keyof typeof ADAPTERS;
function pick<S extends Seam>(seams: SeamsConfig, seam: S): (typeof ADAPTERS)[S][keyof (typeof ADAPTERS)[S]] {
  const all = ADAPTERS[seam];
  const name = seams[seam];
  if (!Object.hasOwn(all, name)) throw new Error(`seams.yml ${seam}: unknown adapter ${name}`);
  return all[name as keyof typeof all];
}

// Where the picked ci seam leaves the secret files. Taken from this file's place and seams.yml, not from env.
const secretDirFor = (ci: string) => (ci === "gitlab" ? GITLAB_SECRET_DIR : SECRET_DIR);

// FACTORY_TARGET comes from a trigger variable: allow only a name with its own targets/<name>.yml.
// A target may pick its own tracker and code host, so GitLab and GitHub repos share one factory.
function forTarget(name: string, base: SeamsConfig) {
  if (!/^[a-z0-9_-]+$/.test(name) || !existsSync(`${TARGETS_DIR}${name}.yml`)) throw new Error(`Unknown FACTORY_TARGET ${name}`);
  const target = loadTarget(name);
  return { target, seams: { ...base, tracker: target.tracker ?? base.tracker, codeHost: target.codeHost ?? base.codeHost } };
}

// A resumed or repeated step posts its comment again. Skip it when the newest comment on the change is already this factory comment.
export function commentOnce(host: CodeHost): CodeHost {
  return {
    ...host,
    async commentChange(ref, text) {
      const [newest] = await host.changeComments(ref);
      if (newest?.byFactory && newest.body.trim().endsWith(text.trim())) return;
      await host.commentChange(ref, text);
    },
  };
}

// The bot account behind a bot token, when it may write to the target: push on the GitHub repo and an editable
// project board, or Developer on the GitLab project. Else undefined, and the target keeps its usual token.
// email: FACTORY_GIT_EMAIL, or else the account's no-reply address, so the host links the commits to the account.
export async function botAccount(name: string, token: string, target: Target, env: NodeJS.ProcessEnv): Promise<{ login: string; email: string } | undefined> {
  try {
    if (name === BOT_SECRETS.FACTORY_GITHUB_TOKEN) {
      const gh = new GitHub(token);
      const repo = needRepo(target);
      if (!(await gh.json("GET", `/repos/${repo}`)).permissions?.push) return undefined;
      if (target.githubProject !== undefined) {
        const d = await gh.graphql(`query($owner: String!, $n: Int!) { repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectV2(number: $n) { viewerCanUpdate } } } }`, { owner: repo.split("/")[0], n: target.githubProject });
        if (!d.repositoryOwner?.projectV2?.viewerCanUpdate) return undefined;
      }
      const u = await gh.json("GET", "/user");
      return { login: u.login, email: env.FACTORY_GIT_EMAIL || `${u.id}+${u.login}@users.noreply.github.com` };
    }
    const gl = new GitLab(GITLAB_URL, token);
    const p = (await gl.getJson(`/projects/${encodeURIComponent(target.projectPath)}`)).permissions;
    if (Math.max(p?.project_access?.access_level ?? 0, p?.group_access?.access_level ?? 0) < 30) return undefined; // 30: Developer
    const u = await gl.getJson("/user");
    return { login: u.username, email: env.FACTORY_GIT_EMAIL || u.commit_email || `${u.id}-${u.username}@users.noreply.${new URL(GITLAB_URL).host}` };
  } catch (e) {
    console.warn(`${name} cannot reach target ${target.name}, so it keeps its usual token: ${errText(e)}`);
    return undefined;
  }
}

// Every string in a webhook payload with the bot's @login written as @factory.
const aliasAll = (v: unknown, login: string): unknown =>
  typeof v === "string" ? asFactoryMention(v, login)
  : Array.isArray(v) ? v.map((x) => aliasAll(x, login))
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, aliasAll(x, login)])) : v;
const aliasComments = (cs: Comment[], login: string) => cs.map((c) => ({ ...c, body: asFactoryMention(c.body, login) }));

// seamsPath is for tests. seams.yml is read from the factory checkout only, never chosen by a variable.
export async function makeContext(env: NodeJS.ProcessEnv, secretDir?: string, seamsPath?: string): Promise<StepContext> {
  const name = needEnv(env, "FACTORY_TARGET");
  const { target, seams } = forTarget(name, loadSeams(seamsPath));
  // Check every name before any adapter is built.
  const make = { ci: pick(seams, "ci"), tracker: pick(seams, "tracker"), codeHost: pick(seams, "codeHost"), judge: pick(seams, "judge"), chat: pick(seams, "chat"), dashboard: pick(seams, "dashboard"), logSource: pick(seams, "logSource") };
  const router = loadRouter(undefined, seams);
  const ci = make.ci(env, secretDir ?? secretDirFor(seams.ci));
  // Each picked adapter's secret, read once per distinct name. Reported in FILE_SECRETS order.
  const picked = [ADAPTER_SECRETS.tracker[seams.tracker], ADAPTER_SECRETS.codeHost[seams.codeHost], ADAPTER_SECRETS.chat[seams.chat], "FACTORY_DASHBOARD_TOKEN"];
  const secrets: Record<string, string> = {};
  for (const n of FILE_SECRETS.filter((n) => picked.includes(n))) {
    const v = ci.secret(n);
    // A missing chat webhook only costs the notices: the step logs them to the console instead of failing.
    if (!v && n === ADAPTER_SECRETS.chat[seams.chat]) {
      console.warn(`${n} is not set: chat notices go to the console`);
      continue;
    }
    if (!v) throw new Error(`${n} is not set`);
    secrets[n] = v;
  }
  // A bot token takes the place of the tracker's or code host's token for a target the bot may write to.
  const accounts: Record<string, { login: string; email: string }> = {};
  for (const user of new Set([ADAPTER_SECRETS.tracker[seams.tracker], ADAPTER_SECRETS.codeHost[seams.codeHost]])) {
    const bot = BOT_SECRETS[user];
    const token = bot && ci.secret(bot);
    if (!token) continue;
    addKnownSecrets(token);
    const account = await botAccount(bot, token, target, env);
    if (account) [secrets[user], accounts[user]] = [token, account];
  }
  const dashboardToken = secrets.FACTORY_DASHBOARD_TOKEN;
  const chatSecret = secrets[ADAPTER_SECRETS.chat[seams.chat]];
  const dashboardUrl = checkDashboardUrl(seams, env);
  // No comment, change text or pushed diff may carry any of these.
  addKnownSecrets(...Object.values(secrets), ...providerKeys(seams).map((k) => env[k]));
  if (env.CI_JOB_IMAGE && env.CI_JOB_IMAGE !== target.jobImage) throw new Error(`The job runs image ${env.CI_JOB_IMAGE}, but target ${name} names ${target.jobImage}`);
  const dir = resolve(RUN_DIR, "target");
  const hostAccount = accounts[ADAPTER_SECRETS.codeHost[seams.codeHost]];
  const trackerAccount = accounts[ADAPTER_SECRETS.tracker[seams.tracker]];
  const host = make.codeHost(secrets[ADAPTER_SECRETS.codeHost[seams.codeHost]], target, env, hostAccount?.email);
  const codeHost = commentOnce(hostAccount ? { ...host, changeComments: async (ref, since) => aliasComments(await host.changeComments(ref, since), hostAccount.login) } : host);
  // With the bot's token the account is no person's, so sharedAccount no longer holds.
  let tracker: Tracker = make.tracker(secrets[ADAPTER_SECRETS.tracker[seams.tracker]], trackerAccount ? { ...target, sharedAccount: false } : target);
  if (trackerAccount) {
    const t = tracker;
    tracker = { ...t, comments: async (ref, since) => aliasComments(await t.comments(ref, since), trackerAccount.login), parseEvent: (p) => t.parseEvent(aliasAll(p, trackerAccount.login)) };
  }
  // A local factory sees only its own tickets and free ones (owner.ts).
  if (env.FACTORY_ID) tracker = ownTickets(tracker, env.FACTORY_ID);
  return {
    tracker,
    codeHost,
    ci,
    judge: make.judge(env, seams),
    chat: chatSecret ? make.chat(chatSecret) : ADAPTERS.chat.console(),
    dashboard: make.dashboard(dashboardUrl, dashboardToken, fetch, `${STATE_DIR}/dashboard-spool`),
    harnesses: HARNESSES,
    seams,
    record: newRecord(),
    target,
    router,
    dir,
    repo: codeHost.cloneAt(dir),
    sleep: (ms) => wait(ms),
  };
}

// The fix step's seams: the dashboard, built first so a plan that fails later is still ended on it, and the code host and
// clone of the factory repo or of a target, built only for the plan's repo. Secrets come through this one CI adapter, as it
// reads and deletes every secret file: a second adapter would find none.
export function makeFixSeams(env: NodeJS.ProcessEnv, secretDir?: string, seamsPath?: string) {
  const seams = loadSeams(seamsPath);
  const ci = pick(seams, "ci")(env, secretDir ?? secretDirFor(seams.ci));
  const dashboardToken = ci.secret("FACTORY_DASHBOARD_TOKEN");
  if (!dashboardToken) throw new Error("FACTORY_DASHBOARD_TOKEN is not set");
  addKnownSecrets(dashboardToken);
  const dashboard = pick(seams, "dashboard")(checkDashboardUrl(seams, env), dashboardToken, fetch, `${STATE_DIR}/dashboard-spool`);
  // The factory's own repo lives on GitLab, whatever code host the targets use.
  const factoryCodeHost = () => {
    if (!seams.factoryRepo) throw new Error("seams.yml has no factoryRepo, so a factory plan cannot run");
    const name = ADAPTER_SECRETS.codeHost.gitlab;
    const token = ci.secret(name);
    if (!token) throw new Error(`${name} is not set, so a factory plan cannot run`);
    addKnownSecrets(token, ...providerKeys(seams).map((k) => env[k]));
    return makeGitLabCodeHost(new GitLab(GITLAB_URL, token), seams.factoryRepo.projectPath, token, env, seams.factoryRepo.baseBranch);
  };
  // A target plan needs only the target's code host: no tracker, chat or judge, so none of their secrets.
  const targetPlace = (name: string) => {
    const t = forTarget(name, seams);
    const key = ADAPTER_SECRETS.codeHost[t.seams.codeHost];
    const make = pick(t.seams, "codeHost");
    const token = ci.secret(key);
    if (!token) throw new Error(`${key} is not set, so a plan for ${name} cannot run`);
    addKnownSecrets(token, ...providerKeys(t.seams).map((k) => env[k]));
    const codeHost = make(token, t.target, env);
    const dir = resolve(RUN_DIR, "target");
    return { codeHost, repo: codeHost.cloneAt(dir), dir, seams: t.seams };
  };
  return { seams, dashboard, factoryCodeHost, targetPlace };
}

// For the manual Jev shadow test on a person's machine: the tracker seams.yml picks, with a token from plain env.
export function makeTracker(token: string, target: Target, seamsPath?: string) {
  return pick(loadSeams(seamsPath), "tracker")(token, target);
}

// The shadow test reads the target's thresholds file through it.
export function makeCodeHost(token: string, target: Target, env: NodeJS.ProcessEnv, seamsPath?: string) {
  return pick(loadSeams(seamsPath), "codeHost")(token, target, env);
}

// The watcher's log source, as seams.yml names it. Only the watcher step needs one.
export const makeLogSource = (seams: SeamsConfig) => pick(seams, "logSource")();
