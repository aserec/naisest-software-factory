import { block, data, isMain, runStep, save, ticketRef, waitFor, type StepContext, type StepResult } from "./context";
import { askPerson } from "./decision";

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
  const message = `[AM] ${gate.commit.message}\nMerge request: ${gate.changeUrl}`;
  // The branch is often behind the base branch: rebase it, at most 3 times, and merge only the reviewed lines on a green head.
  let head = headSha;
  let reviewed: Record<string, string> | undefined;
  const rebased: string[] = [];
  for (;;) {
    const c = await ctx.codeHost.change(change);
    if (c.target !== base) return block(ctx, `Change ${change} targets ${c.target}, not ${base}, so the factory did not merge it.`);
    if (c.head !== head) return block(ctx, `Someone pushed to change ${change} after the review (head ${c.head}, expected ${head}), so the factory did not merge it.`);
    if (c.behind) {
      if (rebased.length === 3) return askPerson(ctx, [`it fell behind ${base} again after 3 rebases. Rebase it by hand and merge it`]);
      reviewed ??= await ctx.codeHost.branchDiff(headSha); // read before the rebase replaces it
      const r = await ctx.codeHost.rebase(change);
      if (!r.ok) return askPerson(ctx, [`the factory could not rebase it onto ${base}: ${r.error}. Rebase it by hand and merge it`]);
      if (!sameChange(reviewed, await ctx.codeHost.branchDiff(r.head))) return block(ctx, `The rebased change ${change} is not the change that was reviewed, so the factory did not merge it.`);
      rebased.push((head = r.head));
    }
    // Merge only after the change's own checks are green on the head that merges.
    const checks = await waitFor(ctx, () => ctx.codeHost.checks({ change, sha: head }));
    if (checks !== "green") return block(ctx, `The change's pipeline is ${checks}, so the factory did not merge.`);
    try {
      save(ctx, "apply", { change, sha: await ctx.codeHost.merge(change, head, message), reviewed: headSha, rebased });
      break;
    } catch (e) {
      if (!(await ctx.codeHost.change(change)).behind) throw e; // the base branch moved since the check: rebase again
    }
  }
  await ctx.tracker.mark(ref, "merged");
  return "next";
}

// The same change: the same files, each with the same added and removed lines in the same order.
// Hunk headers and context lines move when the base moves, so they do not count.
const changedLines = (diff: Record<string, string>) =>
  JSON.stringify(Object.keys(diff).sort().map((file) => [file, diff[file].split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l))]));
const sameChange = (a: Record<string, string>, b: Record<string, string>) => changedLines(a) === changedLines(b);

export const main = () => runStep("apply", run);
if (isMain(import.meta.url)) await main();
