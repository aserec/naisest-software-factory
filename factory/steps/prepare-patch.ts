import { wrapRequest } from "../agents";
import { errText } from "../errors";
import { parseFactoryFile } from "../config";
import { withPort } from "../factory-file";
import { runFacts } from "../record";
import { localPath, localSection } from "../local-instructions";
import { writeShooter } from "../proof";
import type { FactoryCommands } from "../types";
import { NEXT, agent, agentCommands, controls, rootLine, switchOn, CONTINUE, facts, install, isMain, modelRow, prompt, runPort, runStep, save, ticketRef, ticketText, type StepContext, type StepOutcome } from "./context";
import { block, stopReason, stopped, waiting } from "./run";

export const previewLine = (c: FactoryCommands) =>
  c.preview
    ? `Preview: start the app with \`${c.preview}\`. It serves ${c.previewUrl}. ${c.login ? `Login: this repo logs seeded users in with \`${c.login}\`. Read it to learn the user names.` : "Login: this repo has no login command."}`
    : "Preview: this repo has no preview command. Take no screenshots; prove the change with tests only.";

// A conflict round's task: the fixed request, the files the merge left with markers, and what the base branch did since the run began.
async function conflictsText(ctx: StepContext, base: string, files: string[]): Promise<string> {
  // The commits only help the agent: a failed read is logged and the round goes on without them.
  const commits = await ctx.codeHost.baseCommits(ctx.record.startedAt).catch((e) => (console.log(`Reading the commits of ${base} failed: ${errText(e)}`), []));
  return [
    prompt("conflicts").replaceAll("{base}", base).trimEnd(),
    files.length ? `Files with conflict markers:\n${files.map((f) => `- \`${f}\``).join("\n")}` : `No file has conflict markers, but the code host still saw conflicts. Check that your change still works on the new \`${base}\`.`,
    commits.length ? `Commits of \`${base}\` since your run began, newest first:\n${commits.slice(0, 20).map((c) => `- ${c.title}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

export async function run(ctx: StepContext): Promise<StepOutcome> {
  if (!(await switchOn(ctx, "prepare_patch"))) return stopped("prepare-patch", { reason: "switch off prepare_patch" });
  const base = await ctx.codeHost.baseBranch();
  await ctx.repo.clone(base);
  // A resumed run continues the session that hit the limit, in the clone restored from that pipeline.
  // A round start resumes the author's saved session with the round's requests instead.
  const resumeSessionId = facts(ctx).resumeSession("prepare-patch");
  const round = facts(ctx).roundStart ? facts(ctx).openRound : undefined;
  const requests = round && !round.conflicts ? round.requests.map((q) => wrapRequest(q.author, q.body)).join("\n\n") : undefined;
  // A conflict round merges the base branch into the restored clone before install, so install sees the merged lockfile.
  let conflicts = round?.conflicts ? await conflictsText(ctx, base, await ctx.repo.mergeBase(base)) : undefined;
  // Read the commands before the agent runs, so the agent cannot change what the gate runs.
  // A resumed clone or a round's restored clone holds the agent's edits, so it uses the saved commands.
  // raw keeps {port} for the record; commands has this run's port.
  let raw: FactoryCommands | undefined;
  if (resumeSessionId || facts(ctx).roundStart) {
    raw = runFacts(ctx.record).commands;
    if (!raw) return block("The factory could not resume this run: the record has no saved .factory.yml commands.");
  } else {
    // The Settings page's commands; a target with none there still reads .factory.yml from the repo.
    const factoryFile = (await controls(ctx)).settings?.factoryFile ?? ctx.repo.readFile(".factory.yml");
    if (!factoryFile) return block("The target has no .factory.yml commands. Set them on the dashboard's Settings page.");
    raw = parseFactoryFile(factoryFile);
  }
  const commands = withPort(raw, runPort());
  // Markers in a manifest or the lockfile make install fail. The author resolves them first; the gate installs again and blocks if they still fail.
  if (conflicts) {
    const r = await ctx.repo.run(commands.install);
    if (!r.ok) conflicts += `\n\nThe install command failed on the merged files, so the dependencies may be missing. Resolve the conflicts in the package manifests and the lockfile first, and keep the entries of both sides. You cannot run install; the gate runs it again.\n\n${r.output.slice(-1500)}`;
  } else {
    const stop = await install(ctx, commands);
    if (stop) return stop;
  }
  writeShooter(ctx.dir, commands);
  // Backend tickets 111 and 112 used all 60 turns with the checks almost green; fix.ts allows 200.
  const job = { tools: "code", maxTurns: 150, cwd: ctx.dir, commands: agentCommands(commands), ...(commands.preview && { preview: true }) } as const;
  const author = modelRow(ctx).author;
  // A new session has no memory: it gets the repo's instructions and the ticket, then the requests if this is a round.
  const fresh = async () => `${prompt("prepare")}${localSection(await ctx.repo.readBase(localPath("author")))}\n\n${rootLine(ctx.dir)}\n\n${previewLine(commands)}\n\n${await ticketText(ctx)}${requests ? `\n\n${requests}` : ""}${conflicts ? `\n\n${conflicts}` : ""}`;
  // A resumed session already has the repo's instructions, and a round's session already has the ticket.
  const text = !resumeSessionId ? await fresh() : (conflicts ?? (requests ? `${prompt("request")}\n${requests}` : CONTINUE));
  let r = await agent(ctx, "author", author, { ...job, prompt: text, resume: resumeSessionId });
  // The saved session cannot be loaded: do the round in a new session.
  if ((requests || conflicts) && resumeSessionId && !r.ok && !r.stopped && !r.limitHit) r = await agent(ctx, "author", author, { ...job, prompt: await fresh() });
  if (r.stopped) return stopped("prepare-patch", { session: r.session, reason: stopReason(ctx), commands: raw });
  if (r.limitHit) return waiting("prepare-patch", r.session, raw);
  if (!r.ok) return block(`The author run failed: ${r.text.slice(0, 2000)}`);
  // The round's comment shows the author's whole answer; the post cuts it. A round finished after a pause (CONTINUE) keeps its answer too.
  if (facts(ctx).openRound) ctx.record = { ...ctx.record, requestRounds: ctx.record.requestRounds?.map((x, i, all) => (i === all.length - 1 ? { ...x, answer: r.text } : x)) };
  save(ctx, "prepare-patch", { sessionId: r.session, commands: raw });
  await ctx.tracker.mark(ticketRef(ctx), "implemented");
  return NEXT;
}

export const main = () => runStep("prepare-patch", run);
if (isMain(import.meta.url)) await main();
