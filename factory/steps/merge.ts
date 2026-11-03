// Merging exactly the reviewed change, and every line the factory writes into a change and reads back.
// The code host only runs the calls; the rules for what may merge live here.
import type { ChangeRef } from "../seams";
import { save, waitFor, type StepContext, type StepResult } from "./context";
import { askPerson } from "./decision";
import { block, endIfClosed } from "./run";

// The CI skips the pipeline of a commit or change whose title says so, and the hard rules need that pipeline.
// [AM] is the finish run's mark, so no text of the agent or the ticket keeps it. Repeat the replace:
// "[skip [ci skip]ci]" turns into "[skip ci]" after one pass. [ \t]* never eats a newline.
export const withoutMarks = (text: string): string => {
  const out = text.replace(/\[(skip ci|ci skip)\]/gi, "").replace(/\[AM\][ \t]*/gi, "");
  return out === text ? text.trim() : withoutMarks(out);
};

// The line that names the build run, in the commit message and in the change body.
// The finish run finds the build run's record through it (approval and manual merge paths).
export const runLine = (run: string | undefined, runUrl: string | undefined) => `Factory run ${run}: ${runUrl}`;
// No end anchor: a body edited in the web UI may end its lines in \r\n.
export const buildRunOf = (body: string): string | undefined => /^Factory run (\d+): /m.exec(body)?.[1];

// The squash commit message of the factory's own merge. [AM] marks it as the finish run's.
export const mergeMessage = (commitMessage: string, changeUrl: string | undefined) => `[AM] ${commitMessage}\nMerge request: ${changeUrl}`;

// Merge the change only if its head is the reviewed head, or a rebase of it with the same changed lines, on green checks.
// The branch is often behind the base branch: rebase it, at most 3 times. Saves the apply data and returns undefined
// once merged, or returns the step's result when it did not merge.
export async function mergeReviewed(ctx: StepContext, change: ChangeRef, reviewedHead: string, message: string): Promise<StepResult | undefined> {
  const base = await ctx.codeHost.baseBranch();
  let head = reviewedHead;
  let reviewed: Record<string, string> | undefined;
  const rebased: string[] = [];
  const refuse = (c: { open: boolean; target: string; head: string }) =>
    !c.open ? block(ctx, `Change ${change} is no longer open, so the factory did not merge it.`)
    : c.target !== base ? block(ctx, `Change ${change} targets ${c.target}, not ${base}, so the factory did not merge it.`)
    : c.head !== head ? block(ctx, `Someone pushed to change ${change} after the review (head ${c.head}, expected ${head}), so the factory did not merge it.`)
    : undefined;
  for (;;) {
    // Before each rebase and merge: a person may have closed the work item or the change.
    const ended = await endIfClosed(ctx);
    if (ended) return ended;
    const c = await ctx.codeHost.change(change);
    const stop = await refuse(c);
    if (stop) return stop;
    if (c.behind) {
      if (rebased.length === 3) return askPerson(ctx, [`it fell behind ${base} again after 3 rebases. Rebase it by hand and merge it`]);
      reviewed ??= await ctx.codeHost.branchDiff(reviewedHead); // read before the rebase replaces it
      const r = await ctx.codeHost.rebase(change);
      if (!r.ok) return askPerson(ctx, [`the factory could not rebase it onto ${base}: ${r.error}. Rebase it by hand and merge it`]);
      if (!sameChange(reviewed, await ctx.codeHost.branchDiff(r.head))) return block(ctx, `The rebased change ${change} is not the change that was reviewed, so the factory did not merge it.`);
      rebased.push((head = r.head));
    }
    // Merge only after the change's own checks are green on the head that merges.
    const checks = await waitFor(ctx, () => ctx.codeHost.checks({ change, sha: head }));
    if (checks !== "green") return block(ctx, `The change's pipeline is ${checks}, so the factory did not merge.`);
    // The wait can take an hour: a person may have retargeted, pushed to or closed the change since the checks above.
    const endedNow = await endIfClosed(ctx);
    if (endedNow) return endedNow;
    const again = await refuse(await ctx.codeHost.change(change));
    if (again) return again;
    try {
      save(ctx, "apply", { change, sha: await ctx.codeHost.merge(change, head, message), reviewed: reviewedHead, rebased });
      return undefined;
    } catch (e) {
      if (!(await ctx.codeHost.change(change)).behind) throw e; // the base branch moved since the check: rebase again
    }
  }
}

// The same change: the same files, each with the same added and removed lines in the same order.
// Hunk headers and context lines move when the base moves, so they do not count. The diff text has no
// file header lines, so a line that starts with +++ or --- is a changed line too (an added "++i;").
const changedLines = (diff: Record<string, string>) =>
  JSON.stringify(Object.keys(diff).sort().map((file) => [file, diff[file].split("\n").filter((l) => /^[+-]/.test(l))]));
const sameChange = (a: Record<string, string>, b: Record<string, string>) => changedLines(a) === changedLines(b);
