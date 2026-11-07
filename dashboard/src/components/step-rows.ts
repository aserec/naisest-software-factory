import { eventsOfType, type RunEvent } from "software-factory/run-events";
import { words } from "@/lib/utils";

export type SeqEvent = RunEvent & { seq: number };

// One row on the run page: a step, a round of a code review or gate step, or a patch between rounds.
export interface StepRow {
  start: Extract<SeqEvent, { type: "step_start" }>;
  end?: Extract<SeqEvent, { type: "step_end" }>;
  outcome?: string;
  tools: Extract<SeqEvent, { type: "tool_call" }>[];
  events: SeqEvent[]; // the step's other events (findings, checks, usage ...)
  costUsd: number;
  round?: number; // a code review or gate round, or the patch that fixed it
  stepAt?: string; // for a round: when its step started
  label?: string; // a name that replaces the step's own, such as "PR conflict"
}

// The name on a row: "Code review 2", "Patch 2", "Precommit gate 1".
export const stepRowName = (l: StepRow) => l.label ?? `${words(l.start.step ?? "")}${l.round ? ` ${l.round}` : ""}`;

// A conflict round: the event step that continues the run (its step_start carries a round), right after a change_state with conflicts.
// ponytail: a request round on a change that also has conflicts reads as a conflict round too; send `conflicts` on the step_start if that matters.
const conflictRound = (l: StepRow, prev: StepRow | undefined, events: SeqEvent[]) =>
  l.start.step === "event" &&
  (l.start.data as { round?: number }).round !== undefined &&
  events.some((e) => e.type === "change_state" && e.data.conflicts && e.at <= l.start.at && (!prev || e.at >= (prev.end ?? prev.start).at));

// The run's own steps, and each conflict round's steps from its event on, apart, so each can draw its own timeline.
// Request rounds stay in the run's steps.
export function splitRounds(rows: StepRow[], events: SeqEvent[]): { main: StepRow[]; conflicts: StepRow[][] } {
  const main: StepRow[] = [];
  const conflicts: StepRow[][] = [];
  let into = main;
  rows.forEach((l, i) => {
    if (l.start.step === "event" && (l.start.data as { round?: number }).round !== undefined) {
      into = conflictRound(l, rows[i - 1], events) ? [] : main;
      if (into !== main) {
        conflicts.push(into);
        l.label = "PR conflict"; // stepRows makes new rows on each call, so the label changes no one else's
      }
    }
    into.push(l);
  });
  return { main, conflicts };
}

// One row per step_start. A step_end closes the first open row of its step. Tool calls hang on their row by parent.
export function stepRows(events: SeqEvent[]): StepRow[] {
  const sorted = [...events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.seq - b.seq));
  const out: StepRow[] = eventsOfType(sorted, "step_start").map((start) => ({ start, tools: eventsOfType(sorted, "tool_call").filter((e) => e.parent === start.id), events: [], costUsd: 0 }));
  for (const e of eventsOfType(sorted, "step_end")) {
    const row = out.find((l) => !l.end && l.start.step === e.step && l.start.at <= e.at);
    if (row) [row.end, row.outcome] = [e, e.data.outcome];
  }
  const own = new Set(["step_start", "step_end", "tool_call"]);
  for (const row of out) {
    row.events = sorted.filter((e) => !own.has(e.type) && e.step === row.start.step && e.at >= row.start.at && (!row.end || e.at <= row.end.at));
    row.costUsd = eventsOfType(row.events, "usage").reduce((sum, e) => sum + e.data.costUsd, 0);
  }
  const kids = (c: StepRow) => children(c, out);
  return out.flatMap((l) => (out.some((c) => kids(c).includes(l)) ? [] : split(l, kids)));
}

const within = (l: StepRow, c: StepRow) => l !== c && l.start.at >= c.start.at && (l.start.at > c.start.at || l.start.seq > c.start.seq) && (!c.end || l.start.at <= c.end.at);

// The steps run inside a code review or the gate: their patches, and the code review the gate runs after a fix.
// A patch inside that inner review belongs to the review, not to the gate.
function children(c: StepRow, all: StepRow[]): StepRow[] {
  const kind = (l: StepRow) => l.start.step === "patch" || (c.start.step === "precommit-gate" && l.start.step === "code-review");
  if (c.start.step !== "code-review" && c.start.step !== "precommit-gate") return [];
  const mine = all.filter((l) => kind(l) && within(l, c));
  return mine.filter((l) => !mine.some((m) => m.start.step === "code-review" && within(l, m)));
}

// A code review or gate step shows as its rounds with the steps between them: Code review 1, Patch 1, Code review 2 ...
// Each round runs from the step's start or the last inner step's end to the next inner step's start or the step's end.
function split(c: StepRow, kids: (c: StepRow) => StepRow[]): StepRow[] {
  const inner = kids(c);
  if (inner.length === 0) return [c];
  const out: StepRow[] = [];
  let from: SeqEvent = c.start;
  for (const [i, k] of inner.entries()) {
    // A round a patch followed ends "blocking": it found what the patch fixed. A gate round before a review passed.
    const r = round(c, i + 1, from, { ...k.start, type: "step_end", data: { outcome: "next" } }, k.start.step === "patch" ? "blocking" : "next");
    out.push(r, ...(k.start.step === "patch" ? [{ ...k, round: r.round }] : split(k, kids)));
    if (!k.end) return out;
    from = k.end;
  }
  out.push(round(c, inner.length + 1, from, c.end, c.outcome));
  return out;
}

// n counts the rounds in this step. A review round takes its findings' round, which goes on across the review and gate jobs.
function round(c: StepRow, n: number, from: SeqEvent, end: StepRow["end"], outcome?: string): StepRow {
  const start = { ...c.start, id: n === 1 ? c.start.id : `${c.start.id}-${n}`, at: from.at, seq: from.seq };
  const during = <E extends SeqEvent>(e: E) => e.at >= start.at && (!end || e.at <= end.at);
  const events = c.events.filter(during);
  const costUsd = eventsOfType(events, "usage").reduce((sum, e) => sum + e.data.costUsd, 0);
  const found = eventsOfType(events, "review_finding").at(-1)?.data.round;
  return { start, end, outcome, tools: c.tools.filter(during), events, costUsd, round: found ?? n, stepAt: c.start.at };
}

