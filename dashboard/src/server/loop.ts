import type { Db } from "./db";
import { backupDir } from "./db-instance";
import type { Ci } from "./seams";

export interface LoopDeps {
  db: Db;
  ci: Pick<Ci, "cancel" | "importEvents" | "startDispatch">;
  now: Date;
}
// What the loop remembers between ticks. It lives in memory, so a restart imports once and may back up again the same day.
export interface LoopState {
  lastImport: number;
  backupDay: string;
}
export const newLoopState = (): LoopState => ({ lastImport: 0, backupDay: "" });
const shared = newLoopState();

const STOP_WAIT_MS = 60_000;
const IMPORT_EVERY_MS = 10 * 60_000;
const BACKUP_FROM_HOUR = 3; // UTC
const DISPATCH_AGAIN_MS = 15 * 60_000;

// Starts one dispatch run for each target with a waiting dispatch that has no run yet, or whose run started 15 minutes
// ago and did not finish it (the run failed). The run takes every waiting dispatch of its target. The time is set first,
// so a failing start is tried again in 15 minutes, not on every tick. A target with the dispatches switch off waits.
export async function startDispatches({ db, ci, now }: LoopDeps): Promise<void> {
  for (const target of db.dispatchTargets(new Date(now.getTime() - DISPATCH_AGAIN_MS).toISOString())) {
    if (!db.switches(target).dispatches) continue;
    db.dispatchStarted(target, now.toISOString());
    try {
      await ci.startDispatch(target);
    } catch (err) {
      console.error(`loop: starting the dispatch run of ${target} failed`, err);
    }
  }
}

// A stop the step did not honour in 60 s: cancel its CI run. "cancelled" keeps the request pending, so the poller can
// still see the stop, and a cancelled one is skipped here. With no known CI run the request stays pending and a later tick retries.
async function cancelStops({ db, ci, now }: LoopDeps): Promise<void> {
  for (const r of db.requests({ pending: true })) {
    if (r.kind !== "stop" || r.outcome === "cancelled" || now.getTime() - Date.parse(r.at) < STOP_WAIT_MS) continue;
    try {
      // The run ended on its own (no stopped step_end came), so there is nothing to cancel.
      if (db.ended(r.run)) {
        db.finish(r.id, "done");
        continue;
      }
      const pipeline = db.newestPipeline(r.run);
      if (!pipeline) {
        console.error(`loop: stop ${r.id} for run ${r.run} has no CI run yet`);
        continue;
      }
      await ci.cancel(pipeline);
      db.finish(r.id, "cancelled");
    } catch (err) {
      console.error(`loop: cancel for stop ${r.id} failed`, err);
    }
  }
}

// Every 10 minutes: events of finished jobs. The time is set first, so a failing CI is asked again in 10 minutes, not every 10 s.
async function importDue({ db, ci, now }: LoopDeps, state: LoopState): Promise<void> {
  if (now.getTime() - state.lastImport < IMPORT_EVERY_MS) return;
  state.lastImport = now.getTime();
  await ci.importEvents(db);
}

// Once a day after 03:00 UTC: prune and back up. A failure is tried again on the next tick.
async function upkeep({ db, now }: LoopDeps, state: LoopState): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  if (now.getUTCHours() < BACKUP_FROM_HOUR || state.backupDay === day) return;
  db.prune(now);
  db.backup(backupDir(), now);
  state.backupDay = day;
}

// The loop's parts. Each runs on its own timer with its own guard (instrumentation.ts), so a hung CI call in one part
// never holds up the others. Dispatch runs not started yet: a switch turned back on, a failed start or a failed run.
export const loops: Record<string, (deps: LoopDeps, state?: LoopState) => Promise<void>> = {
  stops: (deps) => cancelStops(deps),
  import: (deps, state = shared) => importDue(deps, state),
  dispatches: (deps) => startDispatches(deps),
  upkeep: (deps, state = shared) => upkeep(deps, state),
};

// Every part once, in order. Each part catches its own error, so one failing part never stops the next.
export async function tick(deps: LoopDeps, state: LoopState = shared): Promise<void> {
  for (const [name, part] of Object.entries(loops)) {
    try {
      await part(deps, state);
    } catch (err) {
      console.error(`loop: ${name} failed`, err);
    }
  }
}
