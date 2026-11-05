import { md } from "../conversation";
import { formatResult } from "../record";
import { facts, isMain, notify, runStep, save, ticketRef, type StepContext, type StepResult } from "./context";
import { endRun } from "./run";

export async function run(ctx: StepContext): Promise<StepResult> {
  const ref = ticketRef(ctx);
  const changeUrl = facts(ctx).changeUrl ?? `change ${ctx.ci.vars.change}`;
  const text = formatResult(ctx.record, changeUrl, ctx.ci.vars.runUrl, new Date());
  save(ctx, "result-saved", {});
  // Each "Label: value" line becomes a list item. A JSON value goes in a closed block below the list.
  const rows = text.split("\n").map((l) => /^([^:]+): (.*)$/.exec(l) ?? [l, l, ""]);
  const items = rows.filter(([, , v]) => !v.startsWith("{")).map(([, k, v]) => `- **${k}:** ${v}`);
  const json = rows.filter(([, , v]) => v.startsWith("{")).map(([, k, v]) => `<details><summary>${k}</summary>\n\n\`\`\`json\n${JSON.stringify(JSON.parse(v), null, 2)}\n\`\`\`\n\n</details>`);
  await ctx.tracker.comment(ref, md("✅", "Done", items.join("\n"), ...json));
  await ctx.tracker.close(ref);
  await ctx.tracker.setState(ref, "done");
  endRun(ctx, "done");
  await notify(ctx, "done", text.split("\n"), changeUrl);
  return "next";
}

export const main = () => runStep("result-saved", run);
if (isMain(import.meta.url)) await main();
