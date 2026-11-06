import { facts, isMain, runStep, save, switchOn, ticketRef, type StepContext, type StepResult } from "./context";
import { block, stopped } from "./run";
import { mergeMessage } from "./change-text";
import { mergeReviewed } from "./merge";

export async function run(ctx: StepContext): Promise<StepResult> {
  const ref = ticketRef(ctx);
  const change = ctx.ci.vars.change;
  if (!change) throw new Error("This finish run has no change");
  const f = facts(ctx);
  // The record must belong to this ticket and this change, not to some other run.
  if (ctx.record.workItem !== `${ctx.target.projectPath}#${ref}` || f.change !== change) {
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
  // The switch is about the factory merging, so a finish run after a hand merge (above) never stops for it.
  if (!(await switchOn(ctx, "apply"))) return stopped(ctx, "apply", { reason: "switch off apply", change });
  // Through the watched tracker, so the run's label_change tells the dashboard it runs again after a switch stop.
  await ctx.tracker.setState(ref, "running");
  // Only an auto decision merges without a person. Anything else waits for a person to merge it.
  if (f.decisionKind !== "auto") return block(ctx, `Change ${change} waits for a person to merge it, so the factory did not merge it.`);
  const headSha = f.reviewedHead;
  if (!headSha) return block(ctx, "The run record has no reviewed commit, so the factory did not merge.");
  // A record from before the commit message was saved has no commit: throw, so runStep blocks.
  if (!f.commit?.message) throw new Error("The run record has no commit message, so the factory cannot merge change " + change);
  const stop = await mergeReviewed(ctx, change, headSha, mergeMessage(f.commit.message, f.changeUrl));
  if (stop) return stop;
  await ctx.tracker.mark(ref, "merged");
  return "next";
}

export const main = () => runStep("apply", run);
if (isMain(import.meta.url)) await main();
