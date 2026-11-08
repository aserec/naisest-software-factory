// The fix step: runs one plan a person approved in the dashboard chat, in a clone of the factory repo or of a target,
// and opens a change for people to review. The step ends the plan as done (with the change url) or failed (with why).
import { resolve } from "node:path";
import { makeContext, makeFixSeams } from "../compose";
import { loadRouter, modelChoice } from "../config";
import { errText } from "../errors";
import { HARNESSES } from "../harnesses";
import { RUN_DIR } from "../record";
import { findSecrets, maskSecrets } from "../rules";
import type { AgentPlan, CodeHost, Dashboard, Harness, ModelChoice, Repo } from "../seams";
import { isMain } from "./context";

const numbered = (steps: string[]) => steps.map((s, i) => `${i + 1}. ${s}`).join("\n");

// Only the plan goes to the agent, never the chat that led to it: the person approved the plan, not the talk.
export const fixPrompt = (plan: AgentPlan) =>
  `<plan>\n${plan.summary}\n\n${numbered(plan.steps)}\n</plan>\n\nMake only the changes this plan describes, in this folder. Do not commit or push. If the plan cannot be done as written, change nothing and say why.`;

export async function fix(s: { plan: AgentPlan; codeHost: CodeHost; repo: Repo; harness: Harness; model: ModelChoice; dashboard: Dashboard; dir: string }): Promise<{ url: string } | { failed: string }> {
  const { plan, codeHost, repo } = s;
  await repo.clone(await codeHost.baseBranch());
  // The default sandbox: the agent writes only to its clone and holds no tokens.
  await s.harness.run({ role: "author", tools: "code", maxTurns: 200, cwd: s.dir, model: s.model, prompt: fixPrompt(plan) });
  const diff = await repo.diff();
  if (!diff.text.trim()) return { failed: "The agent made no changes" };
  const title = `fix: ${plan.summary}`;
  const body = `${plan.summary}\n\n${numbered(plan.steps)}\n\nApproved in the dashboard by ${plan.approvedBy ?? "an unknown person"}`;
  // The title goes into the commit and the body to the code host, and a model wrote the plan from chat and screen data.
  if (findSecrets(`${diff.text}\n${title}\n${body}`).length > 0) return { failed: "The fix held a secret, so nothing was pushed" };
  await repo.commitAndPush(`factory-fix/${plan.id.slice(0, 8)}`, title);
  const { url } = await codeHost.openChange(`factory-fix/${plan.id.slice(0, 8)}`, title, body);
  return { url };
}

// The code host, clone and folder the plan runs in.
function place(plan: AgentPlan, env: NodeJS.ProcessEnv, s: ReturnType<typeof makeFixSeams>) {
  if (plan.repo === "target") {
    const ctx = makeContext({ ...env, FACTORY_TARGET: plan.target ?? "" });
    return { codeHost: ctx.codeHost, repo: ctx.repo, dir: ctx.dir, seams: ctx.seams };
  }
  const codeHost = s.factoryCodeHost();
  // Inside the run's own work folder, never the running factory checkout.
  const dir = resolve(RUN_DIR, "factory");
  return { codeHost, repo: codeHost.cloneAt(dir), dir, seams: s.seams };
}

export async function main(env: NodeJS.ProcessEnv = process.env) {
  const plan = JSON.parse(env.FACTORY_PLAN ?? "null") as AgentPlan | null;
  // The id names the branch, so it must be plain.
  if (!plan || typeof plan.id !== "string" || !/^[\w-]{8,}$/.test(plan.id)) throw new Error("FACTORY_PLAN must hold a plan with a plain plan id");
  const s = makeFixSeams(env);
  try {
    if (plan.repo !== "factory" && plan.repo !== "target") throw new Error(`The plan names an unknown repo ${plan.repo}`);
    const p = place(plan, env, s);
    const choice = loadRouter(undefined, p.seams).high.author;
    const r = await fix({ plan, codeHost: p.codeHost, repo: p.repo, harness: HARNESSES[choice.harness], model: modelChoice(choice, p.seams), dashboard: s.dashboard, dir: p.dir });
    if ("url" in r) await s.dashboard.planUpdate(plan.id, "done", r.url);
    else await s.dashboard.planUpdate(plan.id, "failed", r.failed);
    console.log(`Fix ${plan.id}: ${JSON.stringify(r)}`);
  } catch (e) {
    // The plan always ends: a throw anywhere fails it before the step does.
    await s.dashboard.planUpdate(plan.id, "failed", maskSecrets(errText(e, 500))).catch(() => {});
    throw e;
  } finally {
    await s.dashboard.flush();
  }
}
if (isMain(import.meta.url)) await main();
