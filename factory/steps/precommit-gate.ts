import { precommitGate } from "../loops";
import { findSecrets } from "../rules";
import { review } from "./code-review";
import { block, data, fix, install, isMain, runStep, save, stopped, ticketRef, waiting, type StepContext, type StepResult } from "./context";

// The CI skips the pipeline of a commit or change whose title says so, and the hard rules need that pipeline.
const noSkipCi = (title: string) => title.replace(/\[(skip ci|ci skip)\]/gi, "").trim();
const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");

// The finish run finds this run's record through the run link (approval and manual merge paths).
// The code host adds the AI line and the closing line.
export function changeText(ctx: StepContext) {
  const testChanges = ctx.repo.readFile("run/test-changes.md");
  return { title: noSkipCi(ctx.record.ticket!.title), body: [`Factory run ${ctx.ci.vars.run}: ${ctx.ci.vars.runUrl}`, ...(testChanges ? ["Changed tests, and why:", testChanges] : [])].join("\n\n") };
}

export async function run(ctx: StepContext): Promise<StepResult> {
  const ref = ticketRef(ctx);
  const stop = await install(ctx);
  if (stop) return stop;
  // Done only when code review passed on the code the gate passed. A continued gate job may hold changes no review saw.
  let unreviewed = data(ctx, "event")?.resumeAt === "precommit-gate";
  let result;
  for (;;) {
    // A resumed run goes on from its last round. A check after the last fix counts as round 3, never 4.
    const start = Math.min(ctx.record.rounds.gate + 1, 3);
    result = await precommitGate({ review: async () => [], fix: (feedback) => fix(ctx, feedback), run: (cmd) => ctx.repo.run(cmd) }, data(ctx, "prepare-patch").commands, 3, start);
    ctx.record = { ...ctx.record, rounds: { ...ctx.record.rounds, gate: result.rounds } };
    if (result.kind === "limit") return waiting(ctx, "precommit-gate", result.sessionId);
    if (result.kind === "stopped") return stopped(ctx, "precommit-gate", result.sessionId);
    if (result.kind === "blocked") return block(ctx, `The precommit-gate is not green after ${result.rounds} rounds.\n\n${result.open.join("\n")}`);
    if (!unreviewed && result.rounds === start) break; // passed with no fix since the last review
    // The rounds add up across passes, so this ends inside 3 review and 3 gate rounds.
    await ctx.tracker.unmark(ref, "reviewed");
    const r = await review(ctx, "precommit-gate");
    if (typeof r === "string") return r;
    if (!r.fixed) break; // review passed on the code the gate passed
    unreviewed = false; // the review fixed code: run the gate again
  }
  const { title, body } = changeText(ctx);
  // Scan before anything leaves the runner.
  if (findSecrets((await ctx.repo.diff()).text + body).length > 0) return block(ctx, "The change contains a secret-looking value, so the factory did not push it.");
  const branch = `factory/${ref}-${slug(title)}`;
  const sha = await ctx.repo.commitAndPush(branch, `${title} (#${ref})`);
  const c = await ctx.codeHost.openChange(branch, title, body, ref);
  save(ctx, "precommit-gate", { passed: true, rounds: result.rounds, branch, sha, change: c.ref, changeUrl: c.url });
  await ctx.tracker.mark(ref, "checked"); // after the secret scan: a change that is not pushed is not checked
  return "next";
}

export const main = () => runStep("precommit-gate", run);
if (isMain(import.meta.url)) await main();
