import { parseFindings, reviewerPrompt } from "../agents";
import { codeReviewLoop } from "../loops";
import { proofPrompt, readImages, readProof, screenVerdicts, type ProofRecord } from "../proof";
import { agent, block, fix, install, isMain, modelRow, runStep, save, session, stopped, ticketRef, ticketText, waiting, type StepContext, type StepResult } from "./context";

class ReviewerFailed extends Error {}

// One code review loop from the record's next round. The gate job runs it again after a gate fix.
// fixed: the author changed the code during this loop.
export async function review(ctx: StepContext, job: string): Promise<StepResult | { fixed: boolean }> {
  const row = modelRow(ctx);
  const { harness, provider, model } = row.reviewer;
  // Both must agree, or the reviewer would judge screens it cannot see.
  const readsImages = ctx.harnesses[harness].images && (ctx.seams.providers[provider].images ?? []).includes(model);
  let last: { findings: ReturnType<typeof parseFindings>; proof: ReturnType<typeof readProof>; images: Record<string, Buffer> } | undefined;
  const reviewOnce = async () => {
    const proof = readProof(ctx.repo.readFile);
    const images = readImages(ctx.repo.readBytes, proof.proof);
    const attached = readsImages ? Object.keys(images) : [];
    const r = await agent(ctx, "reviewer", row.reviewer, {
      tools: "none",
      prompt: reviewerPrompt(ticketText(ctx), (await ctx.repo.diff()).text, proofPrompt(proof, attached)),
      ...(readsImages ? { images: attached.map((name) => ({ name, data: images[name] })) } : {}),
      cwd: ctx.dir,
      maxTurns: 1,
    });
    if (!r.ok) throw new ReviewerFailed(r.text);
    // A verdict of does_not_match blocks like any blocking finding.
    const findings = parseFindings(r.text).map((f) => (f.verdict === "does_not_match" ? { ...f, blocking: true } : f));
    last = { findings, proof, images };
    return findings;
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
  const proof: ProofRecord = {
    proof: last?.proof.proof,
    error: last?.proof.error,
    verdicts: screenVerdicts(last?.findings ?? [], last?.proof.proof, Object.keys(last?.images ?? {}), readsImages),
    readsImages,
    reviewer: `${harness}/${model}`,
  };
  save(ctx, "code-review", { passed: true, rounds: result.rounds, sessionId: session(ctx), proof });
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
