import { parseFindings, reviewerPrompt } from "../agents";
import { codeReviewLoop } from "../loops";
import { agent, block, fix, install, isMain, modelRow, runStep, save, session, stopped, ticketRef, ticketText, waiting, type StepContext, type StepResult } from "./context";

class ReviewerFailed extends Error {}

// One code review loop from the record's next round. The gate job runs it again after a gate fix.
// fixed: the author changed the code during this loop.
export async function review(ctx: StepContext, job: string): Promise<StepResult | { fixed: boolean }> {
  const row = modelRow(ctx);
  const reviewOnce = async () => {
    const r = await agent(ctx, "reviewer", row.reviewer, { tools: "none", prompt: reviewerPrompt(ticketText(ctx), (await ctx.repo.diff()).text), cwd: ctx.dir, maxTurns: 1 });
    if (!r.ok) throw new ReviewerFailed(r.text);
    return parseFindings(r.text);
  };
  // A resumed run goes on from its last round. A check after the last fix counts as round 3, never 4.
  const start = Math.min(ctx.record.rounds.review + 1, 3);
  let result;
  try {
    result = await codeReviewLoop({
      review: reviewOnce,
      fix: (feedback) => fix(ctx, feedback),
      run: async () => { throw new Error("code review runs no commands"); },
    }, 3, start);
  } catch (e) {
    if (e instanceof ReviewerFailed) return block(ctx, `The reviewer run failed: ${e.message.slice(0, 2000)}`);
    throw e;
  }
  ctx.record = { ...ctx.record, rounds: { ...ctx.record.rounds, review: result.rounds } };
  if (result.kind === "limit") return waiting(ctx, job, result.sessionId);
  if (result.kind === "stopped") return stopped(ctx, job, result.sessionId);
  if (result.kind === "blocked") return block(ctx, `Code review did not pass after ${result.rounds} rounds. Open findings:\n\n${result.open.map((t) => `- ${t}`).join("\n")}`);
  save(ctx, "code-review", { passed: true, rounds: result.rounds, sessionId: session(ctx) });
  await ctx.tracker.mark(ticketRef(ctx), "reviewed");
  return { fixed: result.rounds > start };
}

export async function run(ctx: StepContext): Promise<StepResult> {
  const stop = await install(ctx);
  if (stop) return stop;
  const r = await review(ctx, "code-review");
  return typeof r === "string" ? r : "next";
}

export const main = () => runStep("code-review", run);
if (isMain(import.meta.url)) await main();
