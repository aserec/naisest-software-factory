// Event schema shared by the factory (sender) and the dashboard (receiver).
import { z } from "zod";

export const EVENT_TYPES = ["run_start", "run_end", "step_start", "step_end", "tool_call", "jev_answer", "review_finding", "gate_check", "rule_check", "triage_outcome", "decision", "label_change", "usage", "stop", "resume", "restart", "switch_change", "error"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

// The state of a work item, in factory words. factory/seams.ts re-exports it.
export type FactoryState = "ready" | "running" | "needs_info" | "needs_approval" | "waiting" | "stopped" | "blocked" | "done";
// The audit records the dashboard writes itself. The factory never sends them, and the dashboard refuses them from it.
export const DASHBOARD_TYPES: ReadonlySet<EventType> = new Set(["stop", "resume", "restart", "switch_change"]);

// The steps of a run in order. The CI file and local-run.sh list them too; factory/ci.test.ts checks they agree.
export const STEPS = ["event", "triage", "prepare-patch", "code-review", "precommit-gate", "risk-check", "decision", "apply", "verify", "result-saved"];

export const SWITCHES = ["watcher", "dispatches", "new_runs", "retry", "questions", "prepare_patch", "auto_merge", "apply", "improve"] as const;
export type SwitchName = (typeof SWITCHES)[number];

// The sender cuts long text to this size. The schema only guards it.
export const MAX_FIELD = 20_000;

// The most events one history read returns, oldest first.
export const HISTORY_LIMIT = 5000;

// A diff_risk above this never merges without a person.
export const DIFF_RISK_MAX = 4;

// Minutes before a step counts as stuck. `stuckMinutes` in targets/<name>.yml overrides.
export const STUCK_MINUTES: Record<string, number> = {
  triage: 5,
  "prepare-patch": 120,
  "code-review": 20,
  "precommit-gate": 30,
  "risk-check": 10,
  verify: 90,
};

const field = z.string().max(MAX_FIELD);
const user = z.object({ user: z.string() });

export const EVENT_DATA: Record<EventType, z.ZodTypeAny> = {
  run_start: z.object({}).passthrough(),
  run_end: z.object({ outcome: z.enum(["done", "blocked", "needs_info", "restarted", "closed"]) }),
  step_start: z.object({ prompt: z.string().optional() }).passthrough(),
  // log: the end of the step's output, sent only when no CI job holds it (local-run.sh, the worker).
  step_end: z.object({ outcome: z.enum(["next", "stop", "stopped", "waiting", "error"]), log: field.optional() }),
  tool_call: z.object({ name: z.string(), input: field, result: field, ms: z.number(), ok: z.boolean() }),
  jev_answer: z.object({ question: z.string(), answer: z.string(), confidence: z.string() }),
  // text starts with "file: " when the finding names a file. title and file: older events have neither.
  review_finding: z.object({ text: z.string(), blocking: z.boolean(), round: z.number(), title: z.string().optional(), file: z.string().optional() }),
  gate_check: z.object({ command: z.string(), exitCode: z.number(), outputTail: z.string() }),
  rule_check: z.object({ rule: z.string(), passed: z.boolean(), detail: z.string() }),
  // What triage decided, said once for people: go builds, ask waits for a person's answer, stop ends or blocks the run.
  // url: the original work item when the ticket repeats one.
  triage_outcome: z.object({ kind: z.enum(["go", "ask", "stop"]), title: z.string(), reasons: z.array(z.string()), url: z.string().optional() }),
  // risk: Jev 2's diff_risk, 2 to 10. changeUrl: the merge request. Older events have neither.
  decision: z.object({ auto: z.boolean(), reasons: z.array(z.string()), risk: z.number().optional(), riskMax: z.number().optional(), changeUrl: z.string().optional() }),
  label_change: z.object({ from: z.string().optional(), to: z.string() }),
  usage: z.object({
    role: z.string(),
    model: z.string(),
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    costUsd: z.number(),
    contextTokens: z.number(),
  }),
  stop: user,
  resume: user,
  restart: user,
  switch_change: z.object({ user: z.string(), name: z.enum(SWITCHES), scope: z.string(), on: z.boolean() }),
  error: z.object({ message: z.string() }),
};

export interface RunEvent {
  id: string;
  run: string;
  parent?: string;
  at: string;
  target: string;
  ticket: string;
  pipeline?: string;
  job?: string;
  step?: string;
  type: EventType;
  data: Record<string, unknown>;
}

// The envelope is checked first, then data against EVENT_DATA[type]; issues keep their path under `data`.
export const runEvent = z
  .object({
    id: z.string().uuid(),
    run: z.string(),
    parent: z.string().optional(),
    at: z.string().datetime(),
    target: z.string(),
    ticket: z.string(),
    pipeline: z.string().optional(),
    job: z.string().optional(),
    step: z.string().optional(),
    type: z.enum(EVENT_TYPES),
    data: z.record(z.unknown()),
  })
  .superRefine((e, ctx) => {
    const r = EVENT_DATA[e.type].safeParse(e.data);
    if (r.success) return;
    for (const issue of r.error.issues) ctx.addIssue({ ...issue, path: ["data", ...issue.path] });
  }) as z.ZodType<RunEvent>;

export interface ControlRequest {
  id: string;
  kind: "stop" | "resume" | "restart";
  run: string;
  target: string;
  ticket: string;
  user: string;
  at: string;
  outcome?: "stopped" | "cancelled" | "done" | "refused";
  doneAt?: string;
}

// A dispatch: an outside system (a cron audit, a monitor, anything) tells the factory about a problem.
// The dashboard keeps it until the dispatches job turns it into a ticket. Same source and key = same problem.
export const dispatchInput = z.object({
  target: z.string().min(1).max(200),
  source: z.string().regex(/^[\w.-]{1,100}$/), // e.g. pip-audit
  key: z.string().min(1).max(200), // e.g. the lock file; one open ticket per source and key
  title: z.string().min(1).max(200),
  details: field, // the tool's output: evidence for the ticket
  link: z.string().url().max(2000).optional(), // e.g. the failed CI job
});
export type DispatchInput = z.infer<typeof dispatchInput>;
export interface Dispatch extends DispatchInput { id: string; at: string }

export interface ControlState {
  switches: Record<SwitchName, boolean>;
  stop: boolean;
  requests: ControlRequest[];
}
