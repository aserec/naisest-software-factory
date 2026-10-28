import { parseFactoryFile } from "../config";
import { block, claude, isMain, modelRow, prompt, runStep, save, ticketText, waiting, workItem, type StepContext, type StepResult } from "./context";

export async function run(ctx: StepContext): Promise<StepResult> {
  const { defaultBranch } = await workItem(ctx);
  await ctx.repo.clone(defaultBranch);
  // Read the commands before the agent runs, so the agent cannot change what the gate runs.
  const factoryFile = ctx.repo.readFile(".factory.yml");
  if (!factoryFile) return block(ctx, "The target repo has no .factory.yml.");
  const commands = parseFactoryFile(factoryFile);
  const row = modelRow(ctx);
  const r = await claude(ctx, { prompt: `${prompt("prepare")}\n\n${ticketText(ctx)}`, model: row.author, effort: row.effort, maxTurns: 60, cwd: ctx.dir });
  if (r.limitHit) return waiting(ctx, "prepare-patch", r.sessionId);
  if (r.isError) return block(ctx, `The author run failed: ${r.resultText.slice(0, 500)}`);
  save(ctx, "prepare-patch", { sessionId: r.sessionId, commands });
  return "next";
}

export const main = () => runStep("prepare-patch", run);
if (isMain(import.meta.url)) await main();
