import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { loadRecord, RUN_DIR, type RunRecord } from "../record";
import { STATE_DIR } from "../repo";
import { addKnownSecrets } from "../rules";
import { NotFactoryRunError, type CiRunner, type RunKind, type ChangeRef, type TicketRef } from "../seams";
import { FILE_SECRETS } from "../secrets";
import { checkVars, secretFile } from "../ci-vars";

// The factory's own CI (seams.yml ci: local): factory/worker.ts runs each run, with each step in a new container.
// start() leaves a request in the queue dir; the worker validates it and runs it.
// The worker alone writes the runs dir. It puts there a build run's run/ and an `ok` file once its decision
// step ended well, and mounts the runs a step may read read-only. So only the worker vouches for a run.
export const QUEUE_DIR = `${STATE_DIR}/queue`;
export const RUNS_DIR = `${STATE_DIR}/runs`;
export interface QueuedRun { kind: RunKind; target: string; ticket?: TicketRef; change?: ChangeRef; buildRun?: string; skipApply?: boolean }

export function makeLocalCi(env: NodeJS.ProcessEnv, secretDir: string, dirs = { queue: QUEUE_DIR, runs: RUNS_DIR }): CiRunner {
  checkVars(env, { FACTORY_RUN_ID: /^([0-9]+)?$/ }); // empty in poll, retry and dispatch, which are no run
  const secrets = new Map<string, string>();
  for (const k of FILE_SECRETS) {
    const v = secretFile(env, k, secretDir);
    if (v) secrets.set(k, v);
  }
  addKnownSecrets(...secrets.values());
  const builtRun = (run: string) => {
    const dir = join(dirs.runs, basename(run));
    if (!/^[0-9]+$/.test(run) || !existsSync(join(dir, "ok"))) throw new NotFactoryRunError(`Run ${run} is not a factory build run whose decision passed`);
    return join(dir, RUN_DIR);
  };
  return {
    vars: {
      ticket: env.FACTORY_WORK_ITEM_IID || undefined,
      change: env.FACTORY_MR_IID || undefined,
      skipApply: env.FACTORY_SKIP_APPLY === "1",
      buildRun: env.FACTORY_BUILD_PIPELINE_ID || undefined,
      run: env.FACTORY_RUN_ID || undefined,
      runUrl: "",
      // local-run.sh sets FACTORY_PNPM_STORE. Since it runs the queued finish run itself it also sets FACTORY_LOCAL_FINISH;
      // a run its older copy started has no finish run. ponytail: drop the check once no such run is left.
      noFinish: Boolean(env.FACTORY_PNPM_STORE) && env.FACTORY_LOCAL_FINISH !== "1",
    },
    secret(name) {
      const v = secrets.get(name);
      secrets.delete(name);
      return v;
    },
    async start(run) {
      const q: QueuedRun = { ...run, target: env.FACTORY_TARGET ?? "" };
      mkdirSync(dirs.queue, { recursive: true });
      writeFileSync(join(dirs.queue, `${Date.now()}-${randomUUID()}.json`), JSON.stringify(q));
      return "";
    },
    async buildRecord(run): Promise<RunRecord> {
      return loadRecord(builtRun(run));
    },
    // A resumed run: puts back run/ (clone, git dir, Claude session). The stop file goes: that run stopped at the limit, this one goes on.
    async restoreRun(run) {
      const from = builtRun(run);
      cpSync(from, join(process.cwd(), RUN_DIR), { recursive: true, verbatimSymlinks: true, filter: (src) => src !== join(from, "stop") });
    },
  };
}
