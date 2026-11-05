// The dispatch job: turns the dispatches outside systems sent to the dashboard (POST /api/dispatches) into tickets,
// the same way the watcher turns error groups into tickets. The dashboard starts it when a dispatch arrives.
// It takes every waiting dispatch of the target, so a run started for one also picks up any left from before.
import { makeContext } from "../compose";
import { runDispatches } from "../watcher/run";
import { localPath } from "../local-instructions";
import { agent, isMain, switchOn } from "./context";

export async function main(env: NodeJS.ProcessEnv = process.env) {
  if (env.FACTORY_PIPELINE !== "dispatch") throw new Error("FACTORY_PIPELINE must be dispatch");
  const ctx = makeContext(env);
  // Its own switch, but the same daily cap of ready tickets as the watcher: both open watcher-marked tickets.
  if (!(await switchOn(ctx, "dispatches"))) return console.log("The dispatches switch is off on the dashboard, so dispatches wait.");
  const r = await runDispatches({
    tracker: ctx.tracker,
    judge: ctx.judge,
    chat: ctx.chat,
    now: new Date(),
    writerLocal: await ctx.codeHost.readFile(localPath("writer")),
    writer: (prompt) => agent(ctx, "writer", ctx.router.writer, { tools: "none", maxTurns: 1, prompt, cwd: ctx.dir }),
  }, await ctx.dashboard.dispatches(ctx.target.name), (id, url) => ctx.dashboard.dispatchDone(id, url));
  console.log(`Opened: ${r.opened.join(", ") || "none"}. Blocked: ${r.blocked.join(", ") || "none"}. Dispatches with an open ticket: ${r.skipped.length}.`);
}
if (isMain(import.meta.url)) await main();
