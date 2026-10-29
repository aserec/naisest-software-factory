// Fallback for a webhook that did not fire: a schedule every 5 minutes starts build runs for
// tickets in the ready state. It sets no state. The build's event step re-checks the live state and
// claims the run, as it does for a webhook.
import { makeContext } from "../compose";
import { ACTIVE_STATES, MAX_RUNS_PER_REPO } from "../event";
import type { SwitchName, TicketRef } from "../seams";
import { isMain, parseStoppedNote, switchOn, type StepContext } from "./context";
import { activeRuns, mayStart } from "./event";

export async function pollReady(ctx: StepContext): Promise<TicketRef[]> {
  if (!(await switchOn(ctx, "new_runs"))) return [];
  const free = MAX_RUNS_PER_REPO - (await activeRuns(ctx));
  if (free <= 0) return [];
  const start: TicketRef[] = [];
  for (const t of await ctx.tracker.list("ready")) {
    if (start.length >= free) break;
    if (t.state && ACTIVE_STATES.includes(t.state)) continue;
    // The event step would refuse an untrusted person's start. Skip it here, or it takes a free slot every 5 minutes.
    const actor = await ctx.tracker.startedBy(t.ref);
    if (!actor || !(await mayStart(ctx, actor, t))) continue;
    await ctx.ci.start({ kind: "build", ticket: t.ref });
    start.push(t.ref);
  }
  return start;
}

// A run a dashboard switch stopped goes on once that switch is on again, in the same kind of pipeline it stopped in.
// A build run resumes through its event step, which checks the ticket and the record again.
export async function resumeSwitchedOff(ctx: StepContext): Promise<TicketRef[]> {
  // Unlike a running step, a resume needs the dashboard: a switch someone turned off must not count as on.
  const control = await ctx.dashboard.control(ctx.target.name).catch(() => undefined);
  if (!control) return [];
  const started: TicketRef[] = [];
  for (const { ref } of await ctx.tracker.list("stopped")) {
    // Only the factory's own comment counts, and only the newest stop: a person may have stopped the run since.
    const body = (await ctx.tracker.comments(ref)).find((c) => c.byFactory && parseStoppedNote(c.body))?.body;
    const note = body && parseStoppedNote(body);
    const name = note && /^switch off (\w+)$/.exec(note.reason)?.[1];
    if (!note || !name || !control.switches[name as SwitchName]) continue;
    if (note.step === "apply") {
      // A finish run has no event step to claim the ticket, so claim it here, or the next poll starts it again.
      if (!note.change || !note.buildRun) continue;
      await ctx.tracker.setState(ref, "running");
      await ctx.ci.start({ kind: "finish", ticket: ref, change: note.change, buildRun: note.buildRun });
    } else await ctx.ci.start({ kind: "build", ticket: ref, buildRun: note.run });
    started.push(ref);
  }
  return started;
}

export async function main() {
  if (process.env.FACTORY_SCHEDULE !== "poll") throw new Error("FACTORY_SCHEDULE must be poll");
  const ctx = makeContext(process.env);
  console.log(`Started build runs for tickets: ${(await pollReady(ctx)).join(", ") || "none"}`);
  console.log(`Resumed runs a switch stopped: ${(await resumeSwitchedOff(ctx)).join(", ") || "none"}`);
}
if (isMain(import.meta.url)) await main();
