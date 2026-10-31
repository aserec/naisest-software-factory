// Run events: one line in run/events.jsonl and one send to the dashboard. Nothing happens before the run has an ID.
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { maskSecrets } from "./rules";
import { MAX_FIELD, type EventType, type RunEvent } from "./run-events";
import type { StepContext } from "./steps/context";

// Every string, at any depth, goes through maskSecrets.
const mask = (v: unknown): unknown =>
  typeof v === "string" ? maskSecrets(v) : Array.isArray(v) ? v.map(mask) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mask(x)])) : v;

// Cut after masking, so a cut never leaves half a secret unmasked. A tail keeps its end.
function cut(data: Record<string, unknown>): Record<string, unknown> {
  for (const k of ["input", "result", "outputTail"]) {
    const s = data[k];
    if (typeof s === "string" && s.length > MAX_FIELD) data[k] = k === "outputTail" ? s.slice(-MAX_FIELD) : s.slice(0, MAX_FIELD);
  }
  return data;
}

// The parent is the step's start event unless the caller names another one.
export function emit(ctx: StepContext, type: EventType, data: object, opts: { parent?: string; id?: string } = {}): string | undefined {
  const run = ctx.record.runId;
  if (!run) return undefined;
  const ticket = ctx.ci.vars.ticket ?? (ctx.record.steps.find((s) => s.step === "event")?.data as { ticket?: string } | undefined)?.ticket ?? "";
  const parent = opts.parent ?? (type === "step_start" ? undefined : ctx.stepEvent);
  const e = mask({
    id: opts.id ?? randomUUID(),
    run,
    ...(parent ? { parent } : {}),
    at: new Date().toISOString(),
    target: ctx.target.name,
    ticket,
    ...(ctx.ci.vars.run ? { pipeline: ctx.ci.vars.run } : {}),
    ...(ctx.ci.vars.job ? { job: ctx.ci.vars.job } : {}),
    ...(ctx.step ? { step: ctx.step } : {}),
    type,
    data,
  }) as RunEvent;
  e.data = cut(e.data);
  // The run dir holds the clone (ctx.dir) and the record. CI keeps it as an artifact.
  // A failed write never fails a step: the event still goes to the dashboard.
  try {
    const runDir = dirname(ctx.dir);
    mkdirSync(runDir, { recursive: true });
    appendFileSync(join(runDir, "events.jsonl"), `${JSON.stringify(e)}\n`);
  } catch (err) {
    console.warn(`events.jsonl: could not write ${type} ${e.id}: ${String(err).slice(0, 200)}`);
  }
  ctx.dashboard.send(e);
  return e.id;
}
