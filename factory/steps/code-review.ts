import { parseFindings, reviewerPrompt } from "../agents";
import { emit } from "../emit";
import { codeReviewLoop } from "../loops";
import { proofPrompt, readImages, readProof, screenVerdicts, type ProofRecord } from "../proof";
import { agent, fix, install, isMain, modelRow, runStep, save, facts, ticketRef, ticketText, type StepContext, type StepResult } from "./context";
import { block, stopReason, stopped, waiting } from "./run";

class ReviewerFailed extends Error {}

// One code review loop from the record's next round. The gate job runs it again after a gate fix.
// fixed: the author changed the code during this loop.
export async function review(ctx: StepContext, job: "code-review" | "precommit-gate"): Promise<StepResult | { fixed: boolean }> {
  const row = modelRow(ctx);
  const { harness, provider, model } = row.reviewer;
  // Both must agree, or the reviewer would judge screens it cannot see.
  const readsImages = ctx.harnesses[harness].images && (ctx.seams.providers[provider].images ?? []).includes(model);
  // A resumed run goes on from its last round. A check after the last fix counts as round 3, never 4.
  const start = Math.min(ctx.record.rounds.review + 1, 3);
  let round = start - 1;
  let last: { findings: ReturnType<typeof parseFindings>; proof: ReturnType<typeof readProof>; images: Record<string, Buffer> } | undefined;
  const reviewOnce = async () => {
    round++;
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
    // A does_not_match blocks only for a screen the reviewer could check. Otherwise it stays non-blocking and the screen is unsure.
    const parsed = parseFindings(r.text);
    const judged = screenVerdicts(parsed, proof.proof, Object.keys(images), readsImages);
    const findings = parsed.map((f) => (f.verdict === "does_not_match" && judged.some((v) => v.screen === f.screen && v.verdict === "does_not_match") ? { ...f, blocking: true } : f));
    for (const f of findings) emit(ctx, "review_finding", { text: f.file ? `${f.file}: ${f.text}` : f.text, blocking: f.blocking, round });
    last = { findings, proof, images };
    return findings;
  };
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
  if (result.kind === "stopped") return stopped(ctx, job, { session: result.sessionId, reason: stopReason(ctx) });
  if (result.kind === "blocked") return block(ctx, `Code review did not pass after ${result.rounds} rounds. Open findings:\n\n${result.open.map((t) => `- ${t}`).join("\n")}`);
  const proof: ProofRecord = {
    proof: last?.proof.proof,
    error: last?.proof.error,
    verdicts: screenVerdicts(last?.findings ?? [], last?.proof.proof, Object.keys(last?.images ?? {}), readsImages),
    readsImages,
    reviewer: `${harness}/${model}`,
  };
  save(ctx, "code-review", { passed: true, rounds: result.rounds, sessionId: facts(ctx).session, proof });
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
