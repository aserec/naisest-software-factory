// Run events: one line in run/events.jsonl and one send to the dashboard. Nothing happens before the run has an ID.
import { errText } from "./errors";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { maskSecrets } from "./rules";
import { MAX_FIELD, type EventData, type EventType, type RunEvent } from "./run-events";
import type { Dashboard } from "./seams";
import type { StepContext } from "./steps/context";

// Every string, at any depth, goes through maskSecrets.
const mask = (v: unknown): unknown =>
  typeof v === "string" ? maskSecrets(v) : Array.isArray(v) ? v.map(mask) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mask(x)])) : v;

// Cut after masking, so a cut never leaves half a secret unmasked. A tail keeps its end.
function cut<D extends object>(data: D): D {
  const fields = data as Record<string, unknown>;
  for (const k of ["input", "result", "outputTail", "log"]) {
    const s = fields[k];
    if (typeof s === "string" && s.length > MAX_FIELD) fields[k] = k === "outputTail" || k === "log" ? s.slice(-MAX_FIELD) : s.slice(0, MAX_FIELD);
  }
  return data;
}

// The IDs an event carries. stepEvent: the step's start event, the parent of what the step sends.
export interface RunIds { run?: string; target: string; ticket: string; pipeline?: string; job?: string; step?: string; stepEvent?: string }

// A step's IDs. The ticket is the CI variable, else the one the run's first event step saved.
export const runIds = (ctx: StepContext): RunIds => ({
  run: ctx.record.runId,
  target: ctx.target.name,
  ticket: ctx.ci.vars.ticket ?? (ctx.record.steps.find((s) => s.step === "event")?.data as { ticket?: string } | undefined)?.ticket ?? "",
  pipeline: ctx.ci.vars.run,
  job: ctx.ci.vars.job,
  step: ctx.step,
  stepEvent: ctx.stepEvent,
});

// A step sends with its own IDs.
export const emit = <T extends EventType>(ctx: StepContext, type: T, data: EventData<T>, opts: { parent?: string; id?: string } = {}) => emitFor(runIds(ctx), ctx, type, data, opts);

// to.dir: the target clone; events.jsonl goes in the run dir above it.
// The parent is the step's start event unless the caller names another one.
export function emitFor<T extends EventType>(ids: RunIds, to: { dir: string; dashboard: Dashboard }, type: T, data: EventData<T>, opts: { parent?: string; id?: string } = {}): string | undefined {
  const run = ids.run;
  if (!run) return undefined;
  const parent = opts.parent ?? (type === "step_start" ? undefined : ids.stepEvent);
  // mask and cut work on any depth, so their result is untyped. They only shorten and mask strings, never change a shape.
  const e = mask({
    id: opts.id ?? randomUUID(),
    run,
    ...(parent ? { parent } : {}),
    at: new Date().toISOString(),
    target: ids.target,
    ticket: ids.ticket,
    ...(ids.pipeline ? { pipeline: ids.pipeline } : {}),
    ...(ids.job ? { job: ids.job } : {}),
    ...(ids.step ? { step: ids.step } : {}),
    type,
    data,
  }) as RunEvent;
  e.data = cut(e.data);
  // The run dir holds the clone (to.dir) and the record. CI keeps it as an artifact.
  // A failed write never fails a step: the event still goes to the dashboard.
  try {
    const runDir = dirname(to.dir);
    mkdirSync(runDir, { recursive: true });
    appendFileSync(join(runDir, "events.jsonl"), `${JSON.stringify(e)}\n`);
  } catch (err) {
    console.warn(`events.jsonl: could not write ${type} ${e.id}: ${errText(err, 200)}`);
  }
  to.dashboard.send(e);
  return e.id;
}
