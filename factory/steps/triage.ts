import { wrapTicket } from "../agents";
import { CANDIDATE_BODY, MAX_CANDIDATES, askDuplicateCheck, decideDuplicate } from "../duplicate-check";
import { emit } from "../emit";
import { errText } from "../errors";
import { need } from "../record";
import { pickModels } from "../router";
import type { Ticket } from "../seams";
import { INJECTION_LIMIT, askTriage, buildTriageState, decideTriage, type TriageAnswers } from "../triage";
import type { RouterRow } from "../types";
import { localPath, localSection } from "../local-instructions";
import { conversation, md } from "../conversation";
import { ENDED, NEXT, agent, switchOn, CONTINUE, facts, isMain, notify, prompt, runStep, save, thresholds, ticketRef, ticketText, type StepContext, type StepOutcome } from "./context";
import { block, endRun, stopReason, stopped, waiting } from "./run";

export async function run(ctx: StepContext): Promise<StepOutcome> {
  const ref = ticketRef(ctx);
  // A resumed run: triage already ran, and the questions agent hit the limit or was stopped.
  // A switch stop saved no session, so its resume asks for questions afresh.
  const f = facts(ctx);
  if (f.resumeAt === "triage") return questions(ctx, need(f.row, "triage router row"), f.resumeSession("triage"));
  const ticket = await ctx.tracker.ticket(ref);
  const state = buildTriageState(ticket.title, `${ticket.body}${await requestText(ctx, ticket)}`, ticket.tags);
  let answers: TriageAnswers;
  try {
    answers = await askTriage(ctx.judge, state);
  } catch (e) {
    return block(`Triage failed, so the factory did not guess: ${String(e)}`);
  }
  // A dashboard the factory cannot reach keeps the default clarity limit here.
  const outcome = decideTriage(answers, (await thresholds(ctx)).values.clarityMin);
  const row = pickModels(outcome.kind === "build" ? outcome.risk : answers.risk.value, answers.effort.value, ctx.router);
  // Agents only ever see this checked text, even if the work item changes later.
  ctx.record = { ...ctx.record, ticket: { title: state.title, description: state.description }, models: { author: `${row.author.harness}/${row.author.model}`, reviewer: `${row.reviewer.harness}/${row.reviewer.model}` } };
  save(ctx, "triage", { answers, outcome, row });
  if (outcome.kind !== "blocked") {
    const stopped = await duplicateCheck(ctx, ticket);
    if (stopped) return stopped;
  }
  const a = answers;
  await ctx.tracker.comment(ref, md(
    "🔎",
    "Triage",
    ["| Type | Risk | Clarity | Effort |", "| --- | --- | --- | --- |", `| ${a.type.value} | ${a.risk.value} (confidence ${a.risk.confidence}) | ${a.clarity.value} | ${a.effort.value} |`].join("\n"),
    `**Outcome:** \`${outcome.kind}\``,
  ));

  if (outcome.kind === "blocked") {
    emit(ctx, "triage_outcome", { kind: "stop", title: "Stopped: a person must look at this work item", reasons: [outcome.reason] });
    return block(outcome.reason);
  }
  if (outcome.kind === "build") {
    emit(ctx, "triage_outcome", { kind: "go", title: "Go: the factory builds this work item", reasons: [`Risk ${outcome.risk}, clarity ${a.clarity.value}, effort ${a.effort.value}.`] });
    // One risk mark at a time: the earlier run's other risk marks go.
    const risk = `risk_${outcome.risk}` as const;
    for (const m of ticket.marks) if (m !== risk && ["risk_trivial", "risk_low", "risk_medium", "risk_high"].includes(m)) await ctx.tracker.unmark(ref, m);
    await ctx.tracker.mark(ref, "triaged");
    await ctx.tracker.mark(ref, risk);
    return NEXT;
  }

  emit(ctx, "triage_outcome", { kind: "ask", title: "Asks first: the work item is not clear enough to build", reasons: [`Clarity ${a.clarity.value} is under the limit, so an agent asks the open questions on the work item.`] });
  return questions(ctx, row);
}

// Trusted people's `@factory` comments on the work item, oldest first, such as answers to the factory's questions.
// Triage checks them for injection with the description, and the agents read them as part of it.
// ponytail: buildTriageState cuts the description at MAX_DESCRIPTION, so a long body hides the comments. Summarise them if that bites.
async function requestText(ctx: StepContext, ticket: Ticket): Promise<string> {
  return (await conversation(ctx).itemRequests(ticket.ref)).map((c) => `\n\nComment by ${c.author}:\n${c.body}`).join("");
}

// A work item a person wrote may repeat an open one. A sure duplicate is closed, a near one gets a question.
// Undefined means go on. The factory's own earlier duplicate comment means the person already decided.
async function duplicateCheck(ctx: StepContext, ticket: Ticket): Promise<StepOutcome | undefined> {
  const ref = ticketRef(ctx);
  if (ticket.marks.includes("watcher")) return undefined;
  const conv = conversation(ctx);
  if (await conv.newest(ref, "duplicate")) return undefined;
  let answers;
  let open;
  try {
    open = await ctx.tracker.listOpen(MAX_CANDIDATES + 1);
    answers = await askDuplicateCheck(ctx.judge, { ref, ...ctx.record.ticket! }, open);
  } catch (e) {
    const reason = `The duplicate check failed, so the factory did not guess: ${String(e)}`;
    emit(ctx, "triage_outcome", { kind: "stop", title: "Stopped: a person must look at this work item", reasons: [reason] });
    return block(reason);
  }
  if (!answers) return undefined;
  const verdict = decideDuplicate(answers);
  const o = open.find((t) => t.ref === answers.closest);
  // Without the original the factory can neither link nor quote it, so it goes on.
  if (verdict === "different" || !o) return undefined;
  // Close only when the original is older. A newer one, or refs that are not numbers, get the question.
  const why = `Jev compared it with #${o.ref} "${o.title}" and answered "${answers.verdict}" with ${answers.confidence} confidence.`;
  if (verdict === "same" && Number(o.ref) < Number(ref)) {
    emit(ctx, "triage_outcome", { kind: "stop", title: `Stopped: a duplicate of #${o.ref}, so the factory closed it`, reasons: [why, `#${o.ref} is older, so it keeps the work.`], url: o.url });
    await conv.write(ref, { kind: "duplicate_close", text: md("🔂", "Closed as a duplicate", `This work item asks for the same change as #${o.ref} (${o.url}), so the factory closed it.`, "If it is a separate change, reopen it, say what is different, and add `factory_ready` again.") });
    await ctx.tracker.clearState(ref);
    await ctx.tracker.close(ref);
    endRun(ctx, "closed");
    return ENDED;
  }
  emit(ctx, "triage_outcome", { kind: "ask", title: `Asks first: it may repeat #${o.ref}`, reasons: [why, "The factory closes a work item only when the answer is a sure same and the original is older, so it asked a person."], url: o.url });
  const text = await duplicateQuestion(ctx, o, answers.injectionYes);
  await conv.write(ref, { kind: "duplicate_question", text: md("🔂", "Possible duplicate", text) });
  await ctx.tracker.setState(ref, "needs_info");
  endRun(ctx, "needs_info");
  await notify(ctx, "needs_info", ["The factory asked whether the work item repeats another one."], "");
  return ENDED;
}

// The writer agent words the question, unless the candidates look like an injection or it forgets to name the original.
async function duplicateQuestion(ctx: StepContext, o: Ticket, injectionYes: number): Promise<string> {
  const fixed = `This work item looks close to #${o.ref} (${o.url}). Does it belong in #${o.ref}, or is it a separate change? If it is separate, say what it adds in a comment that mentions \`@factory\`.`;
  if (!(injectionYes < INJECTION_LIMIT)) return fixed;
  const text = `${prompt("duplicate-question")}${localSection(await ctx.codeHost.readFile(localPath("writer")))}\n\n${await ticketText(ctx)}\n\n${wrapTicket(`#${o.ref} ${o.title}\n\n${o.body.slice(0, CANDIDATE_BODY)}`)}`;
  try {
    const r = await agent(ctx, "writer", ctx.router.writer, { tools: "none", maxTurns: 1, cwd: ctx.dir, prompt: text });
    return r.ok && r.text.includes(`#${o.ref}`) ? r.text.trim() : fixed;
  } catch {
    return fixed;
  }
}

// needs_info: an agent drafts questions from the ticket and the code. This step posts them.
async function questions(ctx: StepContext, row: RouterRow, resumeSessionId?: string): Promise<StepOutcome> {
  if (!(await switchOn(ctx, "questions"))) return stopped("questions", { reason: "switch off questions" });
  const ref = ticketRef(ctx);
  await ctx.repo.clone(await ctx.codeHost.baseBranch());
  const text = resumeSessionId ? CONTINUE : `${prompt("questions")}${localSection(await ctx.codeHost.readFile(localPath("writer")))}\n\n${await ticketText(ctx)}`;
  const r = await agent(ctx, "author", row.author, { tools: "code", prompt: text, maxTurns: 15, cwd: ctx.dir, resume: resumeSessionId });
  if (r.stopped) return stopped("questions", { session: r.session, reason: stopReason(ctx) });
  if (r.limitHit) return waiting("questions", r.session);
  if (!r.ok) return block(`The agent could not write questions: ${r.text.slice(0, 500)}`);
  await ctx.tracker.comment(ref, md("❓", "Questions before the build", "This ticket is not clear enough to build yet.", `- 🟡 **Triage:** Decided the ticket needs more information.\n- 🤖 **Author agent, ${row.author.model}:** Read the code and wrote the questions below.\n- 🔵 **You:** Answer in a comment that mentions \`@factory\`, or edit the ticket and add \`factory_ready\` again.`, r.text));
  await ctx.tracker.setState(ref, "needs_info");
  endRun(ctx, "needs_info");
  await notify(ctx, "needs_info", ["The factory asked questions on the ticket."], "");
  return ENDED;
}

export const main = () => runStep("triage", run);
if (isMain(import.meta.url)) await main();
