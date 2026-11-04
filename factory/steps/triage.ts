import { wrapTicket } from "../agents";
import { DEDUPE_MARKER, MAX_CANDIDATES, askDedupe, decideDedupe } from "../dedupe";
import { emit } from "../emit";
import { need } from "../record";
import { pickModels } from "../router";
import type { Ticket } from "../seams";
import { INJECTION_LIMIT, askTriage, buildTriageState, decideTriage, type TriageAnswers } from "../triage";
import type { RouterRow } from "../types";
import { localPath, localSection } from "../local-instructions";
import { agent, switchOn, CONTINUE, facts, isMain, notify, prompt, runStep, save, ticketRef, ticketText, type StepContext, type StepResult } from "./context";
import { block, endRun, stopReason, stopped, waiting } from "./run";

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
  if (outcome.kind !== "blocked") {
    const stopped = await dedupe(ctx, ticket);
    if (stopped) return stopped;
  }
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

// A work item a person wrote may repeat an open one. A sure duplicate is closed, a near one gets a question.
// Undefined means go on. The factory's own earlier dedupe comment means the person already decided.
async function dedupe(ctx: StepContext, ticket: Ticket): Promise<StepResult | undefined> {
  const ref = ticketRef(ctx);
  if (ticket.marks.includes("watcher")) return undefined;
  if ((await ctx.tracker.comments(ref)).some((c) => c.byFactory && c.body.includes(DEDUPE_MARKER))) return undefined;
  let answers;
  let open;
  try {
    open = await ctx.tracker.listOpen(MAX_CANDIDATES + 1);
    answers = await askDedupe(ctx.judge, { ref, ...ctx.record.ticket! }, open);
  } catch (e) {
    return block(ctx, `The duplicate check failed, so the factory did not guess: ${String(e)}`);
  }
  if (!answers) return undefined;
  const verdict = decideDedupe(answers);
  const o = open.find((t) => t.ref === answers.closest);
  // Without the original the factory can neither link nor quote it, so it goes on.
  if (verdict === "different" || !o) return undefined;
  if (verdict === "same") {
    await ctx.tracker.comment(ref, `This work item asks for the same change as #${o.ref} (${o.url}), so the factory closed it as a duplicate. If it is a separate change, reopen it, say what is different, and add factory_ready again.\n\n${DEDUPE_MARKER}`);
    await ctx.tracker.clearState(ref);
    await ctx.tracker.close(ref);
    endRun(ctx, "closed");
    return "stop";
  }
  const text = await dedupeQuestion(ctx, o, answers.injectionYes);
  await ctx.tracker.comment(ref, `${text}\n\n${DEDUPE_MARKER}`);
  await ctx.tracker.setState(ref, "needs_info");
  endRun(ctx, "needs_info");
  await notify(ctx, "needs_info", ["The factory asked whether the work item repeats another one."], "");
  return "stop";
}

// The writer agent words the question, unless the candidates look like an injection or it forgets to name the original.
async function dedupeQuestion(ctx: StepContext, o: Ticket, injectionYes: number): Promise<string> {
  const fixed = `This work item looks close to #${o.ref} (${o.url}). Does it belong in #${o.ref}, or is it a separate change? If it is separate, say what it adds, then add factory_ready again.`;
  if (!(injectionYes < INJECTION_LIMIT)) return fixed;
  const text = `${prompt("dedupe-question")}${localSection(await ctx.codeHost.readFile(localPath("writer")))}\n\n${ticketText(ctx)}\n\n${wrapTicket(`#${o.ref} ${o.title}\n\n${o.body.slice(0, 8000)}`)}`;
  const r = await agent(ctx, "writer", ctx.router.writer, { tools: "none", maxTurns: 1, cwd: ctx.dir, prompt: text });
  return r.ok && r.text.includes(`#${o.ref}`) ? r.text.trim() : fixed;
}

// needs_info: an agent drafts questions from the ticket and the code. This step posts them.
async function questions(ctx: StepContext, row: RouterRow, resumeSessionId?: string): Promise<StepResult> {
  if (!(await switchOn(ctx, "questions"))) return stopped(ctx, "questions", { reason: "switch off questions" });
  const ref = ticketRef(ctx);
  await ctx.repo.clone(await ctx.codeHost.baseBranch());
  const text = resumeSessionId ? CONTINUE : `${prompt("questions")}${localSection(await ctx.codeHost.readFile(localPath("writer")))}\n\n${ticketText(ctx)}`;
  const r = await agent(ctx, "author", row.author, { tools: "code", prompt: text, maxTurns: 15, cwd: ctx.dir, resume: resumeSessionId });
  if (r.stopped) return stopped(ctx, "questions", { session: r.session, reason: stopReason(ctx) });
  if (r.limitHit) return waiting(ctx, "questions", r.session);
  if (!r.ok) return block(ctx, `The agent could not write questions: ${r.text.slice(0, 500)}`);
  await ctx.tracker.comment(ref, `This ticket is not clear enough to build yet. Please answer these questions, then add factory_ready again.\n\n${r.text}`);
  await ctx.tracker.setState(ref, "needs_info");
  endRun(ctx, "needs_info");
  await notify(ctx, "needs_info", ["The factory asked questions on the ticket."], "");
  return "stop";
}

export const main = () => runStep("triage", run);
if (isMain(import.meta.url)) await main();
