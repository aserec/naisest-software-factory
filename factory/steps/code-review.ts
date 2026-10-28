import { codeReviewLoop } from "../loops";
import { block, fix, install, isMain, modelRow, runStep, save, session, ticketText, waiting, type StepContext, type StepResult } from "./context";

export async function run(ctx: StepContext): Promise<StepResult> {
  const stop = await install(ctx);
  if (stop) return stop;
  const row = modelRow(ctx);
  const result = await codeReviewLoop({
    review: async () => ctx.agents.review({ model: row.reviewer, cwd: ctx.dir, diffText: (await ctx.repo.diff()).text, ticketText: ticketText(ctx) }),
    fix: (feedback) => fix(ctx, feedback),
    run: async () => { throw new Error("code review runs no commands"); },
  }, 3, ctx.record.rounds.review + 1); // a resumed run goes on from its last round
  ctx.record = { ...ctx.record, rounds: { ...ctx.record.rounds, review: result.rounds } };
  if (result.kind === "limit") return waiting(ctx, "code-review", result.sessionId);
  if (result.kind === "blocked") return block(ctx, `Code review did not pass after ${result.rounds} rounds. Open findings:\n\n${result.open.map((t) => `- ${t}`).join("\n")}`);
  save(ctx, "code-review", { passed: true, rounds: result.rounds, sessionId: session(ctx) });
  return "next";
}

export const main = () => runStep("code-review", run);
if (isMain(import.meta.url)) await main();
