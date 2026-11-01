import { emit } from "../emit";
import { formatResult } from "../record";
import { facts, isMain, notify, runStep, save, ticketRef, type StepContext, type StepResult } from "./context";

export async function run(ctx: StepContext): Promise<StepResult> {
  const ref = ticketRef(ctx);
  const changeUrl = facts(ctx).changeUrl ?? `change ${ctx.ci.vars.change}`;
  const text = formatResult(ctx.record, changeUrl, ctx.ci.vars.runUrl, new Date());
  save(ctx, "result-saved", {});
  await ctx.tracker.comment(ref, text);
  await ctx.tracker.close(ref);
  await ctx.tracker.setState(ref, "done");
  emit(ctx, "run_end", { outcome: "done" });
  await notify(ctx, "done", text.split("\n"), changeUrl);
  return "next";
}

export const main = () => runStep("result-saved", run);
if (isMain(import.meta.url)) await main();
