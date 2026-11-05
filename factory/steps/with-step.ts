// The only place step_start and step_end are sent (GLOSSARY.md: Step, Event). A step owns the context's step fields
// while it runs: its name, and the ID of its start event, the parent of what it sends.
import { emit } from "../emit";
import type { StepContext } from "./context";

export type StepOutcome = "next" | "stop" | "stopped" | "waiting" | "error";

export interface StepOptions<R> {
  outcome(result: R): StepOutcome; // what the end says when fn returns
  data?: object; // the start's data
  endData?: () => object; // more data for the end, read when it is sent
  // The event step sends its start from startStep, once it knows the run goes on, so a declined start or resume sends nothing.
  deferStart?: boolean;
  onError?(e: unknown): Promise<void>; // runs when fn throws, before the end is sent; the throw goes on after it
}

// Sends the start, runs fn, sends the end (error when fn throws), and gives the context back as it was, so a step
// can run inside another (a patch inside a review). The end goes out only if the start did.
export async function withStep<R>(ctx: StepContext, name: string, fn: () => Promise<R>, o: StepOptions<R>): Promise<R> {
  const outer = { step: ctx.step, stepEvent: ctx.stepEvent };
  ctx.step = name;
  ctx.stepEvent = o.deferStart ? undefined : emit(ctx, "step_start", o.data ?? {});
  let outcome: StepOutcome = "error";
  try {
    const r = await fn();
    outcome = o.outcome(r);
    return r;
  } catch (e) {
    await o.onError?.(e);
    throw e;
  } finally {
    if (ctx.stepEvent) emit(ctx, "step_end", { outcome, ...o.endData?.() });
    Object.assign(ctx, outer);
  }
}

// The start of a step run with deferStart.
export function startStep(ctx: StepContext, data: object = {}): void {
  ctx.stepEvent = emit(ctx, "step_start", data);
}
