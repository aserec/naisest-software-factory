// Trigger callers can set any CI variable. Every factory job must start node and pnpm through `env -i`
// with a fixed allowlist, so NODE_OPTIONS, npm_config_*, PATH and the like never reach them.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { BUILD_STEPS, STEPS as RUN_STEPS } from "./steps/run";
import { main as watcher } from "./steps/watcher";

const ci = parse(readFileSync(new URL("../.gitlab-ci.yml", import.meta.url), "utf8"));
const STEPS = [...RUN_STEPS, "poll", "retry-waiting", "dispatch", "watcher", "improve"];
const PATH = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const passed = (name: string) => `${name}="$${name}"`;
const STEP_PREFIX = [
  "env -i", PATH, "HOME=/root", 'CLAUDE_CONFIG_DIR="$PWD/run/claude-home"', "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
  ...["CI_SERVER_URL", "CI_PROJECT_ID", "CI_PIPELINE_ID", "CI_PIPELINE_URL", "CI_COMMIT_REF_NAME", "CI_JOB_IMAGE", "CI_PIPELINE_SOURCE", "CI_JOB_ID"].map(passed),
  ...["FACTORY_PIPELINE", "FACTORY_TARGET", "FACTORY_WORK_ITEM_IID", "FACTORY_MR_IID", "FACTORY_BUILD_PIPELINE_ID", "FACTORY_SKIP_APPLY", "FACTORY_SCHEDULE"].map(passed),
  // File variables: only their paths pass.
  ...["TRIGGER_PAYLOAD", "FACTORY_GITLAB_TOKEN", "TEAMS_WEBHOOK_URL", "FACTORY_DASHBOARD_TOKEN", "FACTORY_TRIGGER_TOKEN"].map(passed),
  ...["CLAUDE_CODE_OAUTH_TOKEN", "TENSORX_API_KEY", "BERGET_API_KEY"].map(passed),
].join(" ");
const INSTALL = `env -i ${PATH} HOME=/root CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install --frozen-lockfile --filter software-factory`;

test("every factory job starts its step through the env -i allowlist", () => {
  const jobs = Object.keys(ci).filter((k) => !k.startsWith(".") && ["build", "finish", "factory"].some((t) => ci[k]?.extends === `.${t}`));
  expect(jobs.sort()).toEqual([...STEPS].sort());
  expect(ci[".factory"].before_script).toEqual([INSTALL]);
  expect(ci[".factory"].variables).toBeUndefined();
  for (const job of jobs) {
    expect(ci[job].before_script, job).toBeUndefined();
    expect(ci[job].script, job).toEqual([`${STEP_PREFIX} node --import tsx factory/steps/${job}.ts`]);
  }
});

// The step order lives in STEPS. The CI stages and local-run.sh copy it and must not drift.
test(".gitlab-ci.yml and local-run.sh run the steps in the order of STEPS", () => {
  expect((ci.stages as string[]).filter((s) => RUN_STEPS.includes(s))).toEqual(RUN_STEPS);
  for (const step of RUN_STEPS) expect(ci[step].stage, step).toBe(step);
  const local = readFileSync(new URL("../local-run.sh", import.meta.url), "utf8");
  expect(/^steps=\((.*)\)$/m.exec(local)?.[1].split(" ")).toEqual(BUILD_STEPS);
});

test("the allowlist drops NODE_OPTIONS, npm_config_* and the job PATH", () => {
  const out = execFileSync("bash", ["-c", `${STEP_PREFIX} /usr/bin/env`], {
    encoding: "utf8",
    env: { PATH: "/evil:/usr/bin:/bin", NODE_OPTIONS: "--require /evil.js", npm_config_registry: "https://evil", FACTORY_HOOKS_DIR: "/evil", PLAYWRIGHT_BROWSERS_PATH: "/evil", FACTORY_TARGET: "react_frontend", FACTORY_MR_IID: "5" },
  });
  const env = Object.fromEntries(out.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  expect(env.PATH).toBe(PATH.slice(5));
  expect(env).toMatchObject({ PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright", FACTORY_TARGET: "react_frontend", FACTORY_MR_IID: "5" });
  for (const k of ["NODE_OPTIONS", "npm_config_registry", "FACTORY_HOOKS_DIR"]) expect(env[k]).toBeUndefined();
});

test("the poll, retry and improve jobs run only in their own scheduled pipeline", () => {
  expect(ci.poll.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "schedule" && $FACTORY_SCHEDULE == "poll"' }]);
  expect(ci["retry-waiting"].rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "schedule" && $FACTORY_SCHEDULE == "retry"' }]);
  expect(ci.improve.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "schedule" && $FACTORY_SCHEDULE == "improve"' }]);
  expect(ci.dispatch.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "trigger" && $FACTORY_PIPELINE == "dispatch"' }]);
  expect(ci.dispatch.resource_group).toBe("dispatch-$FACTORY_TARGET");
  expect(ci.smoke.rules[0].if).toContain('$CI_PIPELINE_SOURCE != "schedule"');
});

test("the smoke job type-checks before it runs the tests", () => {
  expect(ci.smoke.script).toEqual(["corepack enable", "pnpm install --frozen-lockfile --filter software-factory", "pnpm tsc --noEmit", "pnpm vitest run"]);
});

test("the dashboard job runs in the same pipelines as smoke and installs the whole workspace", () => {
  expect(ci["dashboard-test"].rules).toEqual(ci.smoke.rules);
  expect(ci["dashboard-test"].script).toEqual([
    "corepack enable",
    "pnpm install --frozen-lockfile",
    "pnpm --filter factory-dashboard typecheck",
    "pnpm --filter factory-dashboard test",
    "pnpm --filter factory-dashboard build",
  ]);
});

test("the dashboard e2e job uses the Playwright image of the pinned @playwright/test version", () => {
  const pinned = JSON.parse(readFileSync("dashboard/package.json", "utf8")).devDependencies["@playwright/test"];
  expect(ci["dashboard-e2e"].image).toBe(`mcr.microsoft.com/playwright:v${pinned}-noble`);
  expect(ci["dashboard-e2e"].rules).toEqual(ci.smoke.rules);
});

test("the job image builds only on a push to main", () => {
  expect(ci["job-image"].rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH', changes: ["runner/Dockerfile"] }]);
});

test("the real contract job runs only when started by hand from a web pipeline", () => {
  expect(ci["contract-real"].rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "web"', when: "manual" }]);
});

test("the watcher runs only from a pipeline started by hand", async () => {
  expect(ci.watcher.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "web" && $FACTORY_SCHEDULE == "watch"', when: "manual" }]);
  expect(ci.watcher.stage).toBe("test");
  // With logSource files, main refuses any other pipeline before it reads a secret.
  await expect(watcher({ FACTORY_SCHEDULE: "watch", CI_PIPELINE_SOURCE: "schedule" })).rejects.toThrow(/started by hand/);
  // From a web pipeline it goes on to build the context.
  await expect(watcher({ FACTORY_SCHEDULE: "watch", CI_PIPELINE_SOURCE: "web" })).rejects.toThrow(/is not set/);
});

test("the dashboard deploys only on a push to main that changes what its image holds", () => {
  const job = ci["deploy-dashboard"];
  expect(job.rules).toEqual([{
    if: '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == "main" && $DASHBOARD_HOST',
    changes: ["dashboard/**", "factory/run-events.ts", "deploy/**", "targets/**", "pnpm-lock.yaml"],
  }]);
  expect(job.resource_group).toBe("dashboard-deploy");
  expect(job.environment).toEqual({ name: "dashboard" });
  expect(job.script.at(-1)).toContain("ssh -i \"$DASHBOARD_DEPLOY_KEY\" -o StrictHostKeyChecking=yes -o UserKnownHostsFile=\"$DASHBOARD_KNOWN_HOSTS\" ");
});

