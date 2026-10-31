// The composition root: builds the step context from seams.yml. The one place that knows which tool fills each seam.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeCode } from "./adapters/claude-code";
import { makeGitLabCi } from "./adapters/gitlab-ci";
import { makeGitLabCodeHost } from "./adapters/gitlab-code-host";
import { makeGitLabTracker } from "./adapters/gitlab-tracker";
import { makeFileLogs } from "./adapters/file-logs";
import { makeModelJudge } from "./adapters/model-judge";
import { pi } from "./adapters/pi";
import { makeTeamsChat } from "./adapters/teams-chat";
import { loadRouter, loadSeams, loadTarget, modelChoice } from "./config";
import { GitLab, GITLAB_URL } from "./gitlab";
import { makeJevClient } from "./jev";
import { newRecord, RUN_DIR } from "./record";
import { addKnownSecrets } from "./rules";
import type { StepContext } from "./steps/context";
import { FACTORY_ROOT } from "./steps/repo";
import type { Chat } from "./seams";
import type { SeamsConfig, Target } from "./types";

// Adapter names in seams.yml, and what each one builds. A new adapter is one line here.
const ADAPTERS = {
  ci: { gitlab: makeGitLabCi },
  tracker: { gitlab: (token: string, target: Target) => makeGitLabTracker(new GitLab(GITLAB_URL, token), target.projectPath) },
  codeHost: { gitlab: (token: string, target: Target, env: NodeJS.ProcessEnv) => makeGitLabCodeHost(new GitLab(GITLAB_URL, token), target.projectPath, token, env, target.baseBranch) },
  judge: {
    "jev-berget": (env: NodeJS.ProcessEnv) => makeJevClient(env),
    "model-call": (env: NodeJS.ProcessEnv, seams: SeamsConfig) => makeModelJudge(modelChoice(seams.judgeModel, seams), env),
  },
  chat: {
    teams: makeTeamsChat,
    // Local trials: notices go to the job log.
    console: (): Chat => ({ notify: async (kind, title, lines, url) => console.log(`[chat ${kind}] ${title}\n${lines.join("\n")}\n${url}`) }),
  },
  // The watcher's rules depend on the exact name "files": fake errors from this checkout.
  logSource: { files: () => makeFileLogs(resolve(FACTORY_ROOT, "watcher/fixtures")) },
};
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
  const seams = loadSeams(seamsPath);
  // Check every name before any adapter is built.
  const make = { ci: pick(seams, "ci"), tracker: pick(seams, "tracker"), codeHost: pick(seams, "codeHost"), judge: pick(seams, "judge"), chat: pick(seams, "chat"), logSource: pick(seams, "logSource") };
  const router = loadRouter(undefined, seams);
  const ci = make.ci(env, secretDir);
  const token = ci.secret("FACTORY_GITLAB_TOKEN");
  const webhook = ci.secret("TEAMS_WEBHOOK_URL");
  if (!token) throw new Error("FACTORY_GITLAB_TOKEN is not set");
  if (seams.chat === "teams" && !webhook) throw new Error("TEAMS_WEBHOOK_URL is not set");
  // No comment, change text or pushed diff may carry any of these.
  addKnownSecrets(token, webhook, env.BERGET_API_KEY, ...Object.values(seams.providers).map((p) => env[p.keyEnv]));
  // FACTORY_TARGET comes from a trigger variable: allow only a name with its own targets/<name>.yml.
  const name = need(env, "FACTORY_TARGET");
  if (!/^[a-z0-9_-]+$/.test(name) || !existsSync(fileURLToPath(new URL(`../targets/${name}.yml`, import.meta.url)))) throw new Error(`Unknown FACTORY_TARGET ${name}`);
  const target = loadTarget(name);
  if (env.CI_JOB_IMAGE && env.CI_JOB_IMAGE !== target.jobImage) throw new Error(`The job runs image ${env.CI_JOB_IMAGE}, but target ${name} names ${target.jobImage}`);
  const dir = resolve(RUN_DIR, "target");
  const codeHost = make.codeHost(token, target, env);
  return {
    tracker: make.tracker(token, target),
    codeHost,
    ci,
    judge: make.judge(env, seams),
    chat: make.chat(webhook ?? ""),
    harnesses: { "claude-code": claudeCode, pi },
    seams,
    record: newRecord(),
    target,
    router,
    dir,
    repo: codeHost.cloneAt(dir),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

// For the manual Jev shadow test on a person's machine: the tracker seams.yml picks, with a token from plain env.
export function makeTracker(token: string, target: Target, seamsPath?: string) {
  return pick(loadSeams(seamsPath), "tracker")(token, target);
}

// The watcher's log source, as seams.yml names it. Only the watcher step needs one.
export const makeLogSource = (seams: SeamsConfig) => pick(seams, "logSource")();
