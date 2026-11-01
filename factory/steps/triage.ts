import { emit } from "../emit";
import { need } from "../record";
import { pickModels } from "../router";
import { askTriage, buildTriageState, decideTriage, type TriageAnswers } from "../triage";
import type { RouterRow } from "../types";
import { agent, block, stopReason, switchOn, CONTINUE, facts, isMain, notify, prompt, runStep, save, stopped, ticketRef, ticketText, waiting, type StepContext, type StepResult } from "./context";

export async function run(ctx: StepContext): Promise<StepResult> {
  const ref = ticketRef(ctx);
  // A resumed run: triage already ran, and the questions agent hit the limit or was stopped.
  // A switch stop saved no session, so its resume asks for questions afresh.
  const f = facts(ctx);
  if (f.resumeAt === "triage") return questions(ctx, need(f.row, "triage router row"), f.resumeSession("triage"));
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
  if (outcome.kind === "build") {
    // One risk mark at a time: the earlier run's other risk marks go.
    const risk = `risk_${outcome.risk}` as const;
    for (const m of ticket.marks) if (m !== risk && ["risk_trivial", "risk_low", "risk_medium", "risk_high"].includes(m)) await ctx.tracker.unmark(ref, m);
    await ctx.tracker.mark(ref, "triaged");
    await ctx.tracker.mark(ref, risk);
    return "next";
  }

  return questions(ctx, row);
}

// needs_info: an agent drafts questions from the ticket and the code. This step posts them.
async function questions(ctx: StepContext, row: RouterRow, resumeSessionId?: string): Promise<StepResult> {
  if (!(await switchOn(ctx, "questions"))) return stopped(ctx, "questions", { reason: "switch off questions" });
  const ref = ticketRef(ctx);
  await ctx.repo.clone(await ctx.codeHost.baseBranch());
  const text = resumeSessionId ? CONTINUE : `${prompt("questions")}\n\n${ticketText(ctx)}`;
  const r = await agent(ctx, "author", row.author, { tools: "code", prompt: text, maxTurns: 15, cwd: ctx.dir, resume: resumeSessionId });
  if (r.stopped) return stopped(ctx, "questions", { session: r.session, reason: stopReason(ctx) });
  if (r.limitHit) return waiting(ctx, "questions", r.session);
  if (!r.ok) return block(ctx, `The agent could not write questions: ${r.text.slice(0, 500)}`);
  await ctx.tracker.comment(ref, `This ticket is not clear enough to build yet. Please answer these questions, then add factory_ready again.\n\n${r.text}`);
  await ctx.tracker.setState(ref, "needs_info");
  emit(ctx, "run_end", { outcome: "needs_info" });
  await notify(ctx, "needs_info", ["The factory asked questions on the ticket."], "");
  return "stop";
}

export const main = () => runStep("triage", run);
if (isMain(import.meta.url)) await main();
