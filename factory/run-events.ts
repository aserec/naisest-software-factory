// Event schema shared by the factory (sender) and the dashboard (receiver).
import { z } from "zod";

export const EVENT_TYPES = ["run_start", "run_end", "step_start", "step_end", "tool_call", "jev_answer", "review_finding", "gate_check", "rule_check", "decision", "label_change", "usage", "stop", "resume", "restart", "switch_change", "error"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const SWITCHES = ["watcher", "new_runs", "retry", "questions", "prepare_patch", "auto_merge", "apply"] as const;
export type SwitchName = (typeof SWITCHES)[number];

// The sender cuts long text to this size. The schema only guards it.
export const MAX_FIELD = 20_000;

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
  run_end: z.object({ outcome: z.enum(["done", "blocked", "needs_info", "restarted"]) }),
  step_start: z.object({ prompt: z.string().optional() }).passthrough(),
  step_end: z.object({ outcome: z.enum(["next", "stop", "stopped", "waiting", "error"]) }),
  tool_call: z.object({ name: z.string(), input: field, result: field, ms: z.number(), ok: z.boolean() }),
  jev_answer: z.object({ question: z.string(), answer: z.string(), confidence: z.string() }),
  review_finding: z.object({ text: z.string(), blocking: z.boolean(), round: z.number() }),
  gate_check: z.object({ command: z.string(), exitCode: z.number(), outputTail: z.string() }),
  rule_check: z.object({ rule: z.string(), passed: z.boolean(), detail: z.string() }),
  decision: z.object({ auto: z.boolean(), reasons: z.array(z.string()) }),
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

export interface ControlState {
  switches: Record<SwitchName, boolean>;
  stop: boolean;
  requests: ControlRequest[];
}
