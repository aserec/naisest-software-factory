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
import { checkDashboardUrl, loadRouter, loadSeams, loadTarget, modelChoice, providerKeys } from "./config";
import { makeLocalCi } from "./adapters/local-ci";
import { makeGitHubTracker } from "./adapters/github-tracker";
import { makeGitHubCodeHost } from "./adapters/github-code-host";
import { GitHub } from "./github";
import { GitLab, GITLAB_URL } from "./gitlab";
import { makeJevClient } from "./jev";
import { newRecord, RUN_DIR } from "./record";
import { addKnownSecrets } from "./rules";
import { ADAPTER_SECRETS, FILE_SECRETS } from "./secrets";
import type { StepContext } from "./steps/context";
import { FACTORY_ROOT } from "./repo";
import type { Chat } from "./seams";
import type { SeamsConfig, Target } from "./types";

// Adapter names in seams.yml, and what each one builds. A new adapter is one line here.
const ADAPTERS = {
  ci: { gitlab: makeGitLabCi, local: makeLocalCi },
  // The github trackers and code host get FACTORY_GITHUB_TOKEN; the gitlab ones get FACTORY_GITLAB_TOKEN.
  tracker: {
    gitlab: (token: string, target: Target) => makeGitLabTracker(new GitLab(GITLAB_URL, token), target.projectPath),
    github: (token: string, target: Target) => makeGitHubTracker(new GitHub(token), needRepo(target), undefined, target.sharedAccount),
    "github-project": (token: string, target: Target) => {
      if (!target.githubProject) throw new Error(`Target ${target.name} needs githubProject for the github-project tracker`);
      return makeGitHubTracker(new GitHub(token), needRepo(target), target.githubProject, target.sharedAccount);
    },
  },
  codeHost: {
    gitlab: (token: string, target: Target, env: NodeJS.ProcessEnv) => makeGitLabCodeHost(new GitLab(GITLAB_URL, token), target.projectPath, token, env, target.baseBranch),
    github: (token: string, target: Target, env: NodeJS.ProcessEnv) => makeGitHubCodeHost(new GitHub(token), needRepo(target), token, env, target.baseBranch),
  },
  judge: {
    "jev-berget": (env: NodeJS.ProcessEnv) => makeJevClient(env),
    "model-call": (env: NodeJS.ProcessEnv, seams: SeamsConfig) => makeModelJudge(modelChoice(seams.judgeModel, seams), env),
  },
  chat: {
    teams: makeTeamsChat,
    // Local trials: notices go to the job log.
    console: (): Chat => ({ notify: async (kind, title, lines, url) => console.log(`[chat ${kind}] ${title}\n${lines.join("\n")}\n${url}`) }),
  },
  dashboard: { http: makeHttpDashboard },
  // The watcher's rules depend on the exact name "files": fake errors from this checkout.
  logSource: { files: () => makeFileLogs(resolve(FACTORY_ROOT, "watcher/fixtures")) },
};
// For the secrets test: which names seams.yml may pick for each seam.
export const ADAPTER_NAMES = { tracker: Object.keys(ADAPTERS.tracker), codeHost: Object.keys(ADAPTERS.codeHost), chat: Object.keys(ADAPTERS.chat) };
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

function need(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`${key} is not set`);
  return v;
}

// The runner keeps File-type variables in <project dir>.tmp. Taken from this file's place, not from env.
const SECRET_DIR = `${FACTORY_ROOT}.tmp`;

// seamsPath is for tests. seams.yml is read from the factory checkout only, never chosen by a variable.
export function makeContext(env: NodeJS.ProcessEnv, secretDir = SECRET_DIR, seamsPath?: string): StepContext {
  // FACTORY_TARGET comes from a trigger variable: allow only a name with its own targets/<name>.yml.
  const name = need(env, "FACTORY_TARGET");
  if (!/^[a-z0-9_-]+$/.test(name) || !existsSync(fileURLToPath(new URL(`../targets/${name}.yml`, import.meta.url)))) throw new Error(`Unknown FACTORY_TARGET ${name}`);
  const target = loadTarget(name);
  // A target may pick its own tracker and code host, so GitLab and GitHub repos share one factory.
  const base = loadSeams(seamsPath);
  const seams = { ...base, tracker: target.tracker ?? base.tracker, codeHost: target.codeHost ?? base.codeHost };
  // Check every name before any adapter is built.
  const make = { ci: pick(seams, "ci"), tracker: pick(seams, "tracker"), codeHost: pick(seams, "codeHost"), judge: pick(seams, "judge"), chat: pick(seams, "chat"), dashboard: pick(seams, "dashboard"), logSource: pick(seams, "logSource") };
  const router = loadRouter(undefined, seams);
  const ci = make.ci(env, secretDir);
  // Each picked adapter's secret, read once per distinct name. Reported in FILE_SECRETS order.
  const picked = [ADAPTER_SECRETS.tracker[seams.tracker], ADAPTER_SECRETS.codeHost[seams.codeHost], ADAPTER_SECRETS.chat[seams.chat], "FACTORY_DASHBOARD_TOKEN"];
  const secrets: Record<string, string> = {};
  for (const n of FILE_SECRETS.filter((n) => picked.includes(n))) {
    const v = ci.secret(n);
    if (!v) throw new Error(`${n} is not set`);
    secrets[n] = v;
  }
  const dashboardToken = secrets.FACTORY_DASHBOARD_TOKEN;
  const dashboardUrl = checkDashboardUrl(seams, env);
  // No comment, change text or pushed diff may carry any of these.
  addKnownSecrets(...Object.values(secrets), ...providerKeys(seams).map((k) => env[k]));
  if (env.CI_JOB_IMAGE && env.CI_JOB_IMAGE !== target.jobImage) throw new Error(`The job runs image ${env.CI_JOB_IMAGE}, but target ${name} names ${target.jobImage}`);
  const dir = resolve(RUN_DIR, "target");
  const codeHost = make.codeHost(secrets[ADAPTER_SECRETS.codeHost[seams.codeHost]], target, env);
  return {
    tracker: make.tracker(secrets[ADAPTER_SECRETS.tracker[seams.tracker]], target),
    codeHost,
    ci,
    judge: make.judge(env, seams),
    chat: make.chat(secrets[ADAPTER_SECRETS.chat[seams.chat]] ?? ""),
    dashboard: make.dashboard(dashboardUrl, dashboardToken),
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
