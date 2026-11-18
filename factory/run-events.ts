// Event schema shared by the factory (sender) and the dashboard (receiver).
import { z } from "zod";
import type { ModelPicks } from "./model-picks";

export const EVENT_TYPES = ["run_start", "run_end", "step_start", "step_end", "tool_call", "jev_answer", "review_finding", "gate_check", "rule_check", "triage_outcome", "decision", "change_state", "label_change", "usage", "stop", "resume", "restart", "ready", "switch_change", "settings_change", "error", "prompt"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

// The state of a work item, in factory words. factory/seams.ts re-exports it.
// In board column order.
export const STATES = ["ready", "running", "waiting", "needs_info", "needs_approval", "done", "stopped", "blocked"] as const;
export type FactoryState = (typeof STATES)[number];
// The audit records the dashboard writes itself. The factory never sends them, and the dashboard refuses them from it.
export const DASHBOARD_TYPES: ReadonlySet<EventType> = new Set(["stop", "resume", "restart", "ready", "switch_change", "settings_change"]);

// The steps of a run in order. The CI file and local-run.sh list them too; factory/ci.test.ts checks they agree.
export const STEPS = ["event", "triage", "prepare-patch", "code-review", "precommit-gate", "risk-check", "decision", "apply", "verify", "result-saved"] as const;
// Where a job name sits in STEPS, or -1. CI job names also hold steps that are not in STEPS (poll, watcher), so callers hold plain strings.
const STEP_NAMES: readonly string[] = STEPS;
export const stepIndex = (name = "") => STEP_NAMES.indexOf(name);

export const SWITCHES = ["watcher", "dispatches", "new_runs", "retry", "questions", "prepare_patch", "auto_merge", "merge_all", "apply", "improve"] as const;
export type SwitchName = (typeof SWITCHES)[number];
// Every switch with no saved value is on, except these: they let the factory merge more, so a person must turn them on.
export const OFF_UNTIL_SET: ReadonlySet<SwitchName> = new Set(["merge_all"]);
export const defaultSwitches = () => Object.fromEntries(SWITCHES.map((n) => [n, !OFF_UNTIL_SET.has(n)])) as Record<SwitchName, boolean>;

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
  patch: 120, // a fix round inside code review or the gate
  "code-review": 20,
  "precommit-gate": 30,
  "risk-check": 10,
  verify: 90,
};

const field = z.string().max(MAX_FIELD);
const user = z.object({ user: z.string() });
const limitWindow = z.object({ used: z.number(), resetsAt: z.string() });

// A const object, so each event type keeps its own schema type. `satisfies` makes a missing type a compile error.
export const EVENT_DATA = {
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
  // conflicts: the change does not merge cleanly into the base branch. A conflict round sends it; a later decision clears it on the dashboard.
  change_state: z.object({ conflicts: z.boolean() }),
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
    // The plan's usage windows after this call, 0 to 1 used, when the harness reports them (Claude Code on a plan token).
    limits: z.object({ fiveHour: limitWindow, sevenDay: limitWindow }).optional(),
  }),
  stop: user,
  resume: user,
  restart: user,
  ready: user,
  switch_change: z.object({ user: z.string(), name: z.enum(SWITCHES), scope: z.string(), on: z.boolean() }),
  // The Settings page's whole new value for the target, so the history shows who set which commands.
  settings_change: z.object({ user: z.string(), thresholds: z.record(z.unknown()), factoryFile: z.string().optional(), language: z.string().optional(), models: z.record(z.unknown()).optional() }),
  error: z.object({ message: z.string() }),
  // An agent's prompt, sent when the agent starts: step_start goes before the prompt exists. Masked and cut like a field.
  prompt: z.object({ role: z.string(), prompt: field }),
} satisfies Record<EventType, z.ZodTypeAny>;

// What an event of type T carries in `data`.
export type EventData<T extends EventType = EventType> = z.infer<(typeof EVENT_DATA)[T]>;
export type UsageLimits = NonNullable<EventData<"usage">["limits"]>;

interface Envelope {
  id: string;
  run: string;
  parent?: string;
  at: string;
  target: string;
  ticket: string;
  pipeline?: string;
  job?: string;
  step?: string;
}

// Discriminated on `type`: check `e.type === "usage"` and `e.data` is the usage shape.
export type RunEvent = { [T in EventType]: Envelope & { type: T; data: EventData<T> } }[EventType];
export type EventOf<T extends EventType> = Extract<RunEvent, { type: T }>;
// The events of one type, with the data typed to match. Keeps extra fields on E (the dashboard adds `seq`).
export const eventsOfType = <E extends RunEvent, T extends EventType>(events: readonly E[], type: T): Extract<E, { type: T }>[] =>
  events.filter((e): e is Extract<E, { type: T }> => e.type === type);

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

// runEvent only checks data. This parses it again to drop the keys its type does not know (passthrough types keep theirs).
// The cast: TypeScript cannot tell that parsing EVENT_DATA[e.type] gives the data of that same type.
export const dropUnknownKeys = (e: RunEvent): RunEvent => ({ ...e, data: EVENT_DATA[e.type].parse(e.data) }) as RunEvent;

export interface ControlRequest {
  id: string;
  kind: "stop" | "resume" | "restart" | "ready";
  run: string;
  target: string;
  ticket: string;
  user: string;
  at: string;
  outcome?: "stopped" | "cancelled" | "done" | "refused";
  doneAt?: string;
}

// A plan the dashboard agent proposed. A person approves it on the dashboard; the fix worker then runs it.
export type PlanState = "proposed" | "approved" | "running" | "done" | "failed";
export interface AgentPlan { id: string; path: string; repo: "factory" | "target"; target?: string; summary: string; steps: string[]; state: PlanState; user: string; at: string; approvedBy?: string; result?: string }
export const planProposal = z
  .object({
    repo: z.enum(["factory", "target"]),
    target: z.string().regex(/^[a-z0-9_-]+$/).optional(),
    summary: z.string().min(1).max(500),
    steps: z.array(z.string().min(1).max(1000)).min(1).max(20),
  })
  .refine((p) => p.repo === "factory" || !!p.target, "a target plan needs a target");

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

// The languages the agents can write in, and the dashboard can show. The value is the name the agent prompt uses.
export const LANGUAGES = { en: "English", es: "Spanish", de: "German" } as const;
export type Language = keyof typeof LANGUAGES;
export const isLanguage = (v: unknown): v is Language => typeof v === "string" && Object.hasOwn(LANGUAGES, v);

// A target's Settings page values, raw: the factory checks them (thresholds.ts checkThresholds, config.ts parseFactoryFile).
export interface TargetSettings {
  thresholds: Record<string, unknown>;
  factoryFile?: string; // the .factory.yml commands as YAML text; none means the factory reads .factory.yml from the repo
  language?: Language; // what the agents write for people in; none means the target file's language, else English
  models?: ModelPicks; // the author's and reviewer's model and effort; a role with none uses router.yml (model-picks.ts)
}

export interface ControlState {
  switches: Record<SwitchName, boolean>;
  stop: boolean;
  requests: ControlRequest[];
  settings?: TargetSettings; // an older dashboard sends none: the defaults apply
}
