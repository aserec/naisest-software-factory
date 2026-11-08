// The fix worker: every minute it takes the plans people approved in the dashboard chat and runs the fix step for each,
// one at a time. It is a loop of its own, so restarting the ticket loop never kills a fix in progress.
import { setTimeout as wait } from "node:timers/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeHttpDashboard } from "./adapters/http-dashboard";
import { checkDashboardUrl, loadSeams } from "./config";
import { errText } from "./errors";
import type { AgentPlan, Dashboard } from "./seams";
import { isMain } from "./steps/context";
import { realExec, runShort, type Exec } from "./worker";

// runPlan returns the exit code of the fix step, which itself sets the plan done or failed.
export async function fixTick(dashboard: Dashboard, runPlan: (p: AgentPlan) => Promise<number>) {
  let plans: AgentPlan[];
  try {
    plans = await dashboard.plans();
  } catch (e) {
    console.log(`The fixer could not read the plans: ${errText(e)}`);
    return;
  }
  for (const plan of plans) {
    // false: another worker claimed it, or a person changed it.
    if (!(await dashboard.planUpdate(plan.id, "running").catch(() => false))) continue;
    // The step may already have set the state, so a refused move here is fine.
    const fail = (why: string) => dashboard.planUpdate(plan.id, "failed", why).catch(() => false);
    try {
      const code = await runPlan(plan);
      if (code !== 0) await fail(`The fix step ended with code ${code}`);
    } catch (e) {
      console.log(`The fix for plan ${plan.id} threw: ${errText(e)}`);
      await fail("The fix step could not run");
    }
  }
}

// realExec gives a step the container PATH, which has no node when node comes from nvm or Homebrew (the Mac).
// So name this node by path and keep its folder on the step's PATH, for the tools it starts.
const exec: Exec = (cmd, args, env = {}, cwd) =>
  realExec(cmd === "node" ? process.execPath : cmd, args, { ...env, PATH: `${env.PATH ?? ""}:${dirname(process.execPath)}` }, cwd);

// The fix step clones into run/ of its working folder, so each plan gets a folder of its own, removed afterwards.
const runPlan = (env: NodeJS.ProcessEnv) => async (plan: AgentPlan) => {
  const work = mkdtempSync(join(tmpdir(), "fix-"));
  try {
    return await runShort(exec, env, "fix", plan.target ?? "", undefined, work, { FACTORY_PLAN: JSON.stringify(plan) });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

export async function main(env: NodeJS.ProcessEnv = process.env) {
  const dashboard = makeHttpDashboard(checkDashboardUrl(loadSeams(), env), env.FACTORY_DASHBOARD_TOKEN ?? "");
  // ponytail: a plan stays running when the fixer dies mid-fix; add a claim timeout if that happens.
  for (;;) {
    await fixTick(dashboard, runPlan(env));
    await wait(60_000);
  }
}

if (isMain(import.meta.url)) await main();
