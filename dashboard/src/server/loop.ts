import type { Db } from "./db";
import type { makeGitLab } from "./gitlab";

type GitLab = ReturnType<typeof makeGitLab>;
export interface LoopDeps {
  db: Db;
  gitlab: Pick<GitLab, "cancelPipeline" | "importEvents">;
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
const PAGE = 500;

// The pipeline of the run's newest step_start, or undefined when the run has none that names a pipeline.
function newestPipeline(db: Db, run: string): string | undefined {
  let pipeline: string | undefined;
  for (let after = 0; ; ) {
    const page = db.events({ run, after, limit: PAGE });
    for (const e of page.events) if (e.type === "step_start") pipeline = e.pipeline;
    if (page.events.length < PAGE) return pipeline;
    after = page.cursor;
  }
}

// Each part catches its own error, so one failing part never stops the next.
export async function tick({ db, gitlab, now }: LoopDeps, state: LoopState = shared): Promise<void> {
  // 1. A stop the step did not honour in 60 s: cancel the pipeline. "cancelled" keeps the request pending for the poller (Ruling R4),
  //    so a cancelled one is skipped here. With no known pipeline the request stays pending and a later tick retries.
  try {
    for (const r of db.requests({ pending: true })) {
      if (r.kind !== "stop" || r.outcome === "cancelled" || now.getTime() - Date.parse(r.at) < STOP_WAIT_MS) continue;
      try {
        // The run ended on its own (no stopped step_end came), so there is nothing to cancel.
        if (db.ended(r.run)) {
          db.finish(r.id, "done");
          continue;
        }
        const pipeline = newestPipeline(db, r.run);
        if (!pipeline) {
          console.error(`loop: stop ${r.id} for run ${r.run} has no pipeline yet`);
          continue;
        }
        await gitlab.cancelPipeline(pipeline);
        db.finish(r.id, "cancelled");
      } catch (err) {
        console.error(`loop: cancel for stop ${r.id} failed`, err);
      }
    }
  } catch (err) {
    console.error("loop: reading stop requests failed", err);
  }

  // 2. Every 10 minutes: events of finished jobs. The time is set first, so a failing GitLab is asked again in 10 minutes, not every 10 s.
  if (now.getTime() - state.lastImport >= IMPORT_EVERY_MS) {
    state.lastImport = now.getTime();
    try {
      await gitlab.importEvents(db);
    } catch (err) {
      console.error("loop: import failed", err);
    }
  }

  // 3. Once a day after 03:00 UTC: prune and back up. A failure is tried again on the next tick.
  const day = now.toISOString().slice(0, 10);
  if (now.getUTCHours() >= BACKUP_FROM_HOUR && state.backupDay !== day) {
    try {
      db.prune(now);
      db.backup(process.env.BACKUP_DIR ?? "/data/backups", now);
      state.backupDay = day;
    } catch (err) {
      console.error("loop: prune or backup failed", err);
    }
  }
}
