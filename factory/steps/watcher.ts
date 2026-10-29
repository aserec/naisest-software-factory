// The watcher job: opens tickets for escalating errors. While the errors are fake (logSource files),
// a person starts it by hand: the fixtures stay recent forever, so a schedule would open the same tickets again.
import { makeContext, makeLogSource } from "../compose";
import { loadSeams } from "../config";
import { runWatcher } from "../watcher/run";
import { agent, isMain } from "./context";

export async function main(env: NodeJS.ProcessEnv = process.env) {
  if (env.FACTORY_SCHEDULE !== "watch") throw new Error("FACTORY_SCHEDULE must be watch");
  // Checked before makeContext reads any secret.
  if (loadSeams().logSource === "files" && env.CI_PIPELINE_SOURCE !== "web") throw new Error("With logSource files the watcher runs only in a pipeline started by hand (web)");
  const ctx = makeContext(env);
  const r = await runWatcher({
    logs: makeLogSource(ctx.seams),
    tracker: ctx.tracker,
    judge: ctx.judge,
    chat: ctx.chat,
    now: new Date(),
    writer: (prompt) => agent(ctx, "writer", ctx.router.writer, { tools: "none", maxTurns: 1, prompt, cwd: ctx.dir }),
  });
  console.log(`Opened: ${r.opened.join(", ") || "none"}. Blocked: ${r.blocked.join(", ") || "none"}. Skipped groups with an open ticket: ${r.skipped.length}.`);
}
if (isMain(import.meta.url)) await main();
