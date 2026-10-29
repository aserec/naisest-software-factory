import { parseFindings, reviewerPrompt } from "../agents";
import { emit } from "../emit";
import { codeReviewLoop } from "../loops";
import { agent, block, stopReason, fix, install, isMain, modelRow, runStep, save, session, stopped, ticketText, waiting, type StepContext, type StepResult } from "./context";

class ReviewerFailed extends Error {}

export async function run(ctx: StepContext): Promise<StepResult> {
  const stop = await install(ctx);
  if (stop) return stop;
  const row = modelRow(ctx);
  let round = ctx.record.rounds.review;
  const review = async () => {
    round++;
    const r = await agent(ctx, "reviewer", row.reviewer, { tools: "none", prompt: reviewerPrompt(ticketText(ctx), (await ctx.repo.diff()).text), cwd: ctx.dir, maxTurns: 1 });
    if (!r.ok) throw new ReviewerFailed(r.text);
    const findings = parseFindings(r.text);
    for (const f of findings) emit(ctx, "review_finding", { text: f.file ? `${f.file}: ${f.text}` : f.text, blocking: f.blocking, round });
    return findings;
  };
  let result;
  try {
    result = await codeReviewLoop({
      review,
      fix: (feedback) => fix(ctx, feedback),
      run: async () => { throw new Error("code review runs no commands"); },
    }, 3, ctx.record.rounds.review + 1); // a resumed run goes on from its last round
  } catch (e) {
    if (e instanceof ReviewerFailed) return block(ctx, `The reviewer run failed: ${e.message.slice(0, 500)}`);
    throw e;
  }
  ctx.record = { ...ctx.record, rounds: { ...ctx.record.rounds, review: result.rounds } };
  if (result.kind === "limit") return waiting(ctx, "code-review", result.sessionId);
  if (result.kind === "stopped") return stopped(ctx, "code-review", { session: result.sessionId, reason: stopReason(ctx) });
  if (result.kind === "blocked") return block(ctx, `Code review did not pass after ${result.rounds} rounds. Open findings:\n\n${result.open.map((t) => `- ${t}`).join("\n")}`);
  save(ctx, "code-review", { passed: true, rounds: result.rounds, sessionId: session(ctx) });
  return "next";
}

export const main = () => runStep("code-review", run);
if (isMain(import.meta.url)) await main();
