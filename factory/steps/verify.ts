import { need } from "../record";
import { NEXT, facts, isMain, runStep, save, ticketRef, waitFor, type StepContext, type StepOutcome } from "./context";
import { block } from "./run";

export async function run(ctx: StepContext): Promise<StepOutcome> {
  const branch = await ctx.codeHost.baseBranch();
  const sha = need(facts(ctx).mergedSha, "merged commit");
  const status = await waitFor(ctx, () => ctx.codeHost.checks({ branch, sha }));
  save(ctx, "verify", { status });
  // A repo with no CI runs no main pipeline: the gate on the change was the last check.
  if (status === "green" || status === "absent") {
    const smoke = await runSmoke(ctx, branch);
    return smoke === undefined ? NEXT : revertAndBlock(ctx, sha, `The smoke test \`${facts(ctx).commands!.smoke}\` failed on ${branch} after the merge:\n${smoke.slice(-2000)}\n\n`);
  }
  // Only red checks are a reason to revert. Canceled, skipped, or still no result after an hour: a person checks.
  if (status !== "red") return block(`There is no main pipeline result for ${sha} on ${branch} (status ${status}), so the factory did not revert. A person must check the merge.`);
  return revertAndBlock(ctx, sha, `The ${branch} pipeline is ${status} after the merge. `);
}

// The target's smoke test, when .factory.yml names one (design spec 6.9). Undefined: passed or none; else the failed output.
// ponytail: runs on the branch head, which a later merge may have moved past sha; clone by sha if that bites.
async function runSmoke(ctx: StepContext, branch: string): Promise<string | undefined> {
  const commands = facts(ctx).commands;
  if (!commands?.smoke) return undefined;
  await ctx.repo.clone(branch);
  for (const cmd of [commands.install, commands.smoke]) {
    const r = await ctx.repo.run(cmd);
    if (!r.ok) return r.output;
  }
  return undefined;
}

async function revertAndBlock(ctx: StepContext, sha: string, why: string): Promise<StepOutcome> {
  const revert = await ctx.codeHost.revert(sha);
  await ctx.tracker.mark(ticketRef(ctx), "reverted");
  return block(`${why}A person must merge this revert: ${revert.url}`);
}

export const main = () => runStep("verify", run);
if (isMain(import.meta.url)) await main();
