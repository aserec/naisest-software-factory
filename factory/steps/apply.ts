import { block, data, isMain, runStep, save, ticketRef, waitFor, type StepContext, type StepResult } from "./context";

export async function run(ctx: StepContext): Promise<StepResult> {
  const ref = ticketRef(ctx);
  const change = ctx.ci.vars.change;
  if (!change) throw new Error("This finish run has no change");
  // The record must belong to this ticket and this change, not to some other run.
  if (ctx.record.workItem !== `${ctx.target.projectPath}#${ref}` || data(ctx, "precommit-gate")?.change !== change) {
    return block(ctx, `The run record is for another ticket or change (${ctx.record.workItem || "none"}), so the factory did not merge change ${change}.`);
  }
  if (ctx.ci.vars.skipApply) {
    // A person merged by hand. Nothing to merge; verify checks the landed commit.
    const c = await ctx.codeHost.change(change);
    if (!c.merged) return block(ctx, `The finish run expected change ${change} to be merged, but it is ${c.open ? "open" : "closed"}.`);
    save(ctx, "apply", { change, sha: c.landedSha, skipped: true });
    await ctx.tracker.mark(ref, "merged");
    return "next";
  }
  // Only an auto decision merges without a person. Anything else waits for a person to merge it.
  if (data(ctx, "decision")?.kind !== "auto") return block(ctx, `Change ${change} waits for a person to merge it, so the factory did not merge it.`);
  const headSha = data(ctx, "risk-check")?.headSha;
  if (!headSha) return block(ctx, "The run record has no reviewed commit, so the factory did not merge.");
  const gate = data(ctx, "precommit-gate");
  // A record from before the commit message was saved has no commit: throw, so runStep blocks.
  if (!gate?.commit?.message) throw new Error("The run record has no commit message, so the factory cannot merge change " + change);
  const base = await ctx.codeHost.baseBranch();
  const c = await ctx.codeHost.change(change);
  if (c.target !== base) return block(ctx, `Change ${change} targets ${c.target}, not ${base}, so the factory did not merge it.`);
  // Merge only after the change's own checks are green.
  const checks = await waitFor(ctx, () => ctx.codeHost.checks({ change, sha: headSha }));
  if (checks !== "green") return block(ctx, `The change's pipeline is ${checks}, so the factory did not merge.`);
  const message = `[AM] ${gate.commit.message}\nMerge request: ${gate.changeUrl}`;
  save(ctx, "apply", { change, sha: await ctx.codeHost.merge(change, headSha, message) });
  await ctx.tracker.mark(ref, "merged");
  return "next";
}

export const main = () => runStep("apply", run);
if (isMain(import.meta.url)) await main();
