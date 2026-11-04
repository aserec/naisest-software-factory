import { wrapRequest } from "../agents";
import { parseFactoryFile } from "../config";
import { localPath, localSection } from "../local-instructions";
import type { FactoryCommands } from "../types";
import { agent, switchOn, CONTINUE, facts, install, isMain, modelRow, prompt, runStep, save, ticketRef, ticketText, type StepContext, type StepResult } from "./context";
import { block, stopReason, stopped, waiting } from "./run";

export const previewLine = (c: FactoryCommands) =>
  c.preview ? `Preview: start the app with \`${c.preview}\`. It serves ${c.previewUrl}.` : "Preview: this repo has no preview command. Take no screenshots; prove the change with tests only.";

export async function run(ctx: StepContext): Promise<StepResult> {
  if (!(await switchOn(ctx, "prepare_patch"))) return stopped(ctx, "prepare-patch", { reason: "switch off prepare_patch" });
  await ctx.repo.clone(await ctx.codeHost.baseBranch());
  // A resumed run continues the session that hit the limit, in the clone restored from that pipeline.
  // A round start resumes the author's saved session with the round's requests instead.
  const resumeSessionId = facts(ctx).resumeSession("prepare-patch");
  const requests = facts(ctx).roundStart ? facts(ctx).openRound?.requests.map((q) => wrapRequest(q.author, q.body)).join("\n\n") : undefined;
  // Read the commands before the agent runs, so the agent cannot change what the gate runs.
  // A resumed clone holds the agent's edits, so it uses the commands saved at the limit.
  let commands: FactoryCommands | undefined;
  if (resumeSessionId) {
    commands = facts(ctx).commands;
    if (!commands) return block(ctx, "The factory could not resume this run: the record has no saved .factory.yml commands.");
  } else {
    const factoryFile = ctx.repo.readFile(".factory.yml");
    if (!factoryFile) return block(ctx, "The target repo has no .factory.yml.");
    commands = parseFactoryFile(factoryFile);
  }
  const stop = await install(ctx, commands);
  if (stop) return stop;
  const job = { tools: "code", maxTurns: 60, cwd: ctx.dir, ...(commands.preview && { preview: true }) } as const;
  const author = modelRow(ctx).author;
  // A new session has no memory: it gets the repo's instructions and the ticket, then the requests if this is a round.
  const fresh = async () => `${prompt("prepare")}${localSection(await ctx.repo.readBase(localPath("author")))}\n\n${previewLine(commands)}\n\n${ticketText(ctx)}${requests ? `\n\n${requests}` : ""}`;
  // A resumed session already has the repo's instructions, and a round's session already has the ticket.
  const text = !resumeSessionId ? await fresh() : requests ? `${prompt("request")}\n${requests}` : CONTINUE;
  let r = await agent(ctx, "author", author, { ...job, prompt: text, resume: resumeSessionId });
  // The saved session cannot be loaded: do the round in a new session.
  if (requests && resumeSessionId && !r.ok && !r.stopped && !r.limitHit) r = await agent(ctx, "author", author, { ...job, prompt: await fresh() });
  if (r.stopped) return stopped(ctx, "prepare-patch", { session: r.session, reason: stopReason(ctx), extra: { commands } });
  if (r.limitHit) return waiting(ctx, "prepare-patch", r.session, { commands });
  if (!r.ok) return block(ctx, `The author run failed: ${r.text.slice(0, 2000)}`);
  // The round's comment shows the author's whole answer; the post cuts it.
  if (requests) ctx.record = { ...ctx.record, requestRounds: ctx.record.requestRounds?.map((x, i, all) => (i === all.length - 1 ? { ...x, answer: r.text } : x)) };
  save(ctx, "prepare-patch", { sessionId: r.session, commands });
  await ctx.tracker.mark(ticketRef(ctx), "implemented");
  return "next";
}

export const main = () => runStep("prepare-patch", run);
if (isMain(import.meta.url)) await main();
