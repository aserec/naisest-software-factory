import { AI_LINE } from "../gitlab";
import { precommitGate } from "../loops";
import { findSecrets } from "../rules";
import { block, data, fix, isMain, runStep, save, waiting, workItem, type StepContext, type StepResult } from "./context";

const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");

export async function run(ctx: StepContext): Promise<StepResult> {
  const { projectId, iid, defaultBranch } = await workItem(ctx);
  const result = await precommitGate(
    { review: async () => [], fix: (feedback) => fix(ctx, feedback), run: (cmd) => ctx.repo.run(cmd) },
    data(ctx, "prepare-patch").commands,
  );
  if (result.kind === "limit") return waiting(ctx, "precommit-gate", result.sessionId);
  ctx.record = { ...ctx.record, rounds: { ...ctx.record.rounds, gate: result.rounds } };
  if (result.kind === "blocked") return block(ctx, `The precommit-gate is not green after ${result.rounds} rounds.\n\n${result.open.join("\n")}`);

  const title = ctx.record.ticket!.title;
  const testChanges = ctx.repo.readFile("run/test-changes.md");
  const description = [AI_LINE, `Closes #${iid}`, ...(testChanges ? ["Changed tests, and why:", testChanges] : [])].join("\n\n");
  // Scan before anything leaves the runner.
  if (findSecrets((await ctx.repo.diff(defaultBranch)).text + description).length > 0) return block(ctx, "The change contains a secret-looking value, so the factory did not push it.");
  const branch = `factory/${iid}-${slug(title)}`;
  await ctx.repo.commitAndPush(branch, `${title} (#${iid})`);
  const mr = await ctx.gitlab.openMergeRequest(projectId, branch, defaultBranch, title, description);
  save(ctx, "precommit-gate", { passed: true, rounds: result.rounds, branch, mrIid: mr.iid, mrUrl: mr.webUrl });
  return "next";
}

export const main = () => runStep("precommit-gate", run);
if (isMain(import.meta.url)) await main();
