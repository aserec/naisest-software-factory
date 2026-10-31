import { pickModels } from "../router";
import { askTriage, buildTriageState, decideTriage, type TriageAnswers } from "../triage";
import type { RouterRow } from "../types";
import { agent, block, CONTINUE, data, isMain, notify, prompt, resumeSession, runStep, save, stopped, ticketRef, ticketText, waiting, type StepContext, type StepResult } from "./context";

export async function run(ctx: StepContext): Promise<StepResult> {
  const ref = ticketRef(ctx);
  // A resumed run: triage already ran, the questions agent hit the limit.
  const resumeSessionId = resumeSession(ctx, "triage");
  if (resumeSessionId) return questions(ctx, data(ctx, "triage").row, resumeSessionId);
  const ticket = await ctx.tracker.ticket(ref);
  const state = buildTriageState(ticket.title, ticket.body, ticket.tags);
  let answers: TriageAnswers;
  try {
    answers = await askTriage(ctx.judge, state);
  } catch (e) {
    return block(ctx, `Triage failed, so the factory did not guess: ${String(e)}`);
  }
  const outcome = decideTriage(answers);
  const row = pickModels(outcome.kind === "build" ? outcome.risk : answers.risk.value, answers.effort.value, ctx.router);
  // Agents only ever see this checked text, even if the work item changes later.
  ctx.record = { ...ctx.record, ticket: { title: state.title, description: state.description }, models: { author: `${row.author.harness}/${row.author.model}`, reviewer: `${row.reviewer.harness}/${row.reviewer.model}` } };
  save(ctx, "triage", { answers, outcome, row });
  const a = answers;
  await ctx.tracker.comment(ref, [
    `Triage: type ${a.type.value}, risk ${a.risk.value} (confidence ${a.risk.confidence}), clarity ${a.clarity.value}, effort ${a.effort.value}.`,
    `Outcome: ${outcome.kind}.`,
  ].join("\n"));

  if (outcome.kind === "blocked") return block(ctx, outcome.reason);
  if (outcome.kind === "build") return "next";

  return questions(ctx, row);
}

// needs_info: an agent drafts questions from the ticket and the code. This step posts them.
async function questions(ctx: StepContext, row: RouterRow, resumeSessionId?: string): Promise<StepResult> {
  const ref = ticketRef(ctx);
  await ctx.repo.clone(await ctx.codeHost.defaultBranch());
  const text = resumeSessionId ? CONTINUE : `${prompt("questions")}\n\n${ticketText(ctx)}`;
  const r = await agent(ctx, "author", row.author, { tools: "code", prompt: text, maxTurns: 15, cwd: ctx.dir, resume: resumeSessionId });
  if (r.stopped) return stopped(ctx, "questions", r.session);
  if (r.limitHit) return waiting(ctx, "questions", r.session);
  if (!r.ok) return block(ctx, `The agent could not write questions: ${r.text.slice(0, 500)}`);
  await ctx.tracker.comment(ref, `This ticket is not clear enough to build yet. Please answer these questions, then add factory_ready again.\n\n${r.text}`);
  await ctx.tracker.setState(ref, "needs_info");
  await notify(ctx, "needs_info", ["The factory asked questions on the ticket."], "");
  return "stop";
}

export const main = () => runStep("triage", run);
if (isMain(import.meta.url)) await main();
