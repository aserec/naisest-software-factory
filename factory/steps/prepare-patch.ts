import { parseFactoryFile } from "../config";
import type { FactoryCommands } from "../types";
import { agent, block, CONTINUE, data, install, isMain, modelRow, prompt, resumeSession, runStep, save, ticketText, waiting, type StepContext, type StepResult } from "./context";

export async function run(ctx: StepContext): Promise<StepResult> {
  await ctx.repo.clone(await ctx.codeHost.defaultBranch());
  // A resumed run continues the session that hit the limit, in the clone restored from that pipeline.
  const resumeSessionId = resumeSession(ctx, "prepare-patch");
  // Read the commands before the agent runs, so the agent cannot change what the gate runs.
  // A resumed clone holds the agent's edits, so it uses the commands saved at the limit.
  let commands: FactoryCommands;
  if (resumeSessionId) {
    commands = data(ctx, "prepare-patch")?.commands;
    if (!commands) return block(ctx, "The factory could not resume this run: the record has no saved .factory.yml commands.");
  } else {
    const factoryFile = ctx.repo.readFile(".factory.yml");
    if (!factoryFile) return block(ctx, "The target repo has no .factory.yml.");
    commands = parseFactoryFile(factoryFile);
  }
  const stop = await install(ctx, commands);
  if (stop) return stop;
  const text = resumeSessionId ? CONTINUE : `${prompt("prepare")}\n\n${ticketText(ctx)}`;
  const r = await agent(ctx, "author", modelRow(ctx).author, { tools: "code", prompt: text, maxTurns: 60, cwd: ctx.dir, resume: resumeSessionId });
  if (r.limitHit) return waiting(ctx, "prepare-patch", r.session, { commands });
  if (!r.ok) return block(ctx, `The author run failed: ${r.text.slice(0, 500)}`);
  save(ctx, "prepare-patch", { sessionId: r.session, commands });
  return "next";
}

export const main = () => runStep("prepare-patch", run);
if (isMain(import.meta.url)) await main();
