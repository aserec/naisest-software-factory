// The fix step: runs one plan a person approved in the dashboard chat, in a clone of the factory repo or of a target,
// and opens a change for people to review. The step ends the plan as done (with the change url) or failed (with why).
import { resolve } from "node:path";
import { makeFixSeams } from "../compose";
import { loadRouter, modelChoice } from "../config";
import { HARNESSES } from "../harnesses";
import { RUN_DIR } from "../record";
import { findSecrets, maskSecrets } from "../rules";
import type { AgentPlan, CodeHost, Harness, ModelChoice, Repo } from "../seams";
import { isMain } from "./context";

const numbered = (steps: string[]) => steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
// Text for the dashboard: masked first, so a cut can never leave half a secret that no longer matches.
const shown = (text: string) => maskSecrets(text).slice(0, 500);

// Only the plan goes to the agent, never the chat that led to it: the person approved the plan, not the talk.
export const fixPrompt = (plan: AgentPlan) =>
  `<plan>\n${plan.summary}\n\n${numbered(plan.steps)}\n</plan>\n\nMake only the changes this plan describes, in this folder. Do not commit or push. If the plan cannot be done as written, change nothing and say why.`;

export async function fix(s: { plan: AgentPlan; codeHost: CodeHost; repo: Repo; harness: Harness; model: ModelChoice; dir: string }): Promise<{ url: string } | { failed: string }> {
  const { plan, codeHost, repo } = s;
  await repo.clone(await codeHost.baseBranch());
  // The default sandbox: the agent writes only to its clone and holds no tokens.
  const run = await s.harness.run({ role: "author", tools: "code", maxTurns: 200, cwd: s.dir, model: s.model, prompt: fixPrompt(plan) });
  const said = run.text.trim() ? `: ${shown(run.text)}` : "";
  // A run that failed or stopped may have left half the plan done: push none of it.
  if (!run.ok || run.limitHit || run.stopped) return { failed: `The agent did not finish${said}` };
  const diff = await repo.diff();
  // The agent says why when it cannot do the plan as written.
  if (!diff.text.trim()) return { failed: `The agent made no changes${said}` };
  const title = `fix: ${plan.summary}`;
  const body = `${plan.summary}\n\n${numbered(plan.steps)}\n\nApproved in the dashboard by ${plan.approvedBy ?? "an unknown person"}`;
  // The title goes into the commit and the body to the code host, and a model wrote the plan from chat and screen data.
  if (findSecrets(`${diff.text}\n${title}\n${body}`).length > 0) return { failed: "The fix held a secret, so nothing was pushed" };
  await repo.commitAndPush(`factory-fix/${plan.id.slice(0, 8)}`, title);
  const { url } = await codeHost.openChange(`factory-fix/${plan.id.slice(0, 8)}`, title, body);
  return { url };
}

// The code host, clone and folder the plan runs in.
function place(plan: AgentPlan, s: ReturnType<typeof makeFixSeams>) {
  if (plan.repo === "target") return s.targetPlace(plan.target ?? "");
  const codeHost = s.factoryCodeHost();
  // Inside the run's own work folder, never the running factory checkout.
  const dir = resolve(RUN_DIR, "factory");
  return { codeHost, repo: codeHost.cloneAt(dir), dir, seams: s.seams };
}

// deps is for tests: the secret folder and seams.yml to read, and the fix to run.
export async function main(env: NodeJS.ProcessEnv = process.env, deps: { secretDir?: string; seamsPath?: string; fix?: typeof fix } = {}) {
  const plan = JSON.parse(env.FACTORY_PLAN ?? "null") as AgentPlan | null;
  // The id names the branch, so it must be plain.
  if (!plan || typeof plan.id !== "string" || !/^[\w-]{8,}$/.test(plan.id)) throw new Error("FACTORY_PLAN must hold a plan with a plain plan id");
  const s = makeFixSeams(env, deps.secretDir, deps.seamsPath);
  try {
    if (plan.repo !== "factory" && plan.repo !== "target") throw new Error(`The plan names an unknown repo ${plan.repo}`);
    const p = place(plan, s);
    const choice = loadRouter(undefined, p.seams).high.author;
    const r = await (deps.fix ?? fix)({ plan, codeHost: p.codeHost, repo: p.repo, harness: HARNESSES[choice.harness], model: modelChoice(choice, p.seams), dir: p.dir });
    if ("url" in r) await s.dashboard.planUpdate(plan.id, "done", r.url);
    else await s.dashboard.planUpdate(plan.id, "failed", r.failed);
    console.log(`Fix ${plan.id}: ${JSON.stringify(r)}`);
  } catch (e) {
    // The plan always ends: a throw anywhere fails it before the step does.
    await s.dashboard.planUpdate(plan.id, "failed", shown(String(e))).catch(() => {});
    throw e;
  } finally {
    await s.dashboard.flush();
  }
}
if (isMain(import.meta.url)) await main();
