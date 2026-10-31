import { emit } from "../emit";
import { precommitGate } from "../loops";
import { findSecrets } from "../rules";
import { block, data, fix, install, isMain, stopReason, runStep, save, stopped, ticketRef, waiting, type StepContext, type StepResult } from "./context";

// The CI skips the pipeline of a commit or change whose title says so, and the hard rules need that pipeline.
const noSkipCi = (title: string) => title.replace(/\[(skip ci|ci skip)\]/gi, "").trim();
const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");

export async function run(ctx: StepContext): Promise<StepResult> {
  const ref = ticketRef(ctx);
  const stop = await install(ctx);
  if (stop) return stop;
  const result = await precommitGate(
    { review: async () => [], fix: (feedback) => fix(ctx, feedback), run: async (cmd) => {
      const r = await ctx.repo.run(cmd);
      // ponytail: the Repo seam gives ok, not the exit code; add it to Repo.run if the dashboard needs the real code.
      emit(ctx, "gate_check", { command: cmd, exitCode: r.ok ? 0 : 1, outputTail: r.output });
      return r;
    } },
    data(ctx, "prepare-patch").commands,
    3,
    ctx.record.rounds.gate + 1, // a resumed run goes on from its last round
  );
  ctx.record = { ...ctx.record, rounds: { ...ctx.record.rounds, gate: result.rounds } };
  if (result.kind === "limit") return waiting(ctx, "precommit-gate", result.sessionId);
  if (result.kind === "stopped") return stopped(ctx, "precommit-gate", { session: result.sessionId, reason: stopReason(ctx) });
  if (result.kind === "blocked") return block(ctx, `The precommit-gate is not green after ${result.rounds} rounds.\n\n${result.open.join("\n")}`);

  const title = noSkipCi(ctx.record.ticket!.title);
  const testChanges = ctx.repo.readFile("run/test-changes.md");
  // The finish run finds this run's record through the run link (approval and manual merge paths).
  // The code host adds the AI line and the closing line.
  const body = [`Factory run ${ctx.ci.vars.run}: ${ctx.ci.vars.runUrl}`, ...(testChanges ? ["Changed tests, and why:", testChanges] : [])].join("\n\n");
  // Scan before anything leaves the runner.
  if (findSecrets((await ctx.repo.diff()).text + body).length > 0) return block(ctx, "The change contains a secret-looking value, so the factory did not push it.");
  const branch = `factory/${ref}-${slug(title)}`;
  const sha = await ctx.repo.commitAndPush(branch, `${title} (#${ref})`);
  const c = await ctx.codeHost.openChange(branch, title, body, ref);
  save(ctx, "precommit-gate", { passed: true, rounds: result.rounds, branch, sha, change: c.ref, changeUrl: c.url });
  return "next";
}

export const main = () => runStep("precommit-gate", run);
if (isMain(import.meta.url)) await main();
