import { block, data, isMain, runStep, save, ticketRef, waitFor, type StepContext, type StepResult } from "./context";

export async function run(ctx: StepContext): Promise<StepResult> {
  const branch = await ctx.codeHost.baseBranch();
  const { sha } = data(ctx, "apply");
  const status = await waitFor(ctx, () => ctx.codeHost.checks({ branch, sha }));
  save(ctx, "verify", { status });
  if (status === "green") {
    // ponytail: no smoke step yet; a target that names one goes to a person until it is built.
    if (data(ctx, "prepare-patch")?.commands?.smoke) return block(ctx, "The target's .factory.yml names a smoke test, but the factory cannot run smoke tests yet. A person must run it.");
    return "next";
  }
  // Only red checks are a reason to revert. Canceled, skipped, or still no result after an hour: a person checks.
  if (status !== "red") return block(ctx, `There is no main pipeline result for ${sha} on ${branch} (status ${status}), so the factory did not revert. A person must check the merge.`);
  const revert = await ctx.codeHost.revert(sha);
  await ctx.tracker.mark(ticketRef(ctx), "reverted");
  return block(ctx, `The ${branch} pipeline is ${status} after the merge. A person must merge this revert: ${revert.url}`);
}

export const main = () => runStep("verify", run);
if (isMain(import.meta.url)) await main();
