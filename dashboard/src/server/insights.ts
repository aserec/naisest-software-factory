import { STEPS, type RunEvent } from "software-factory/run-events";
import type { RunSummary } from "./db";

// What became of a run: the decision event says whether the factory merged alone or sent the change to a person.
// The dashboard does not see a person's merge, so "person" means sent to a person, not merged by one.
export type RunKind = "auto" | "person" | "stopped" | "open";

export interface Insights {
  weeks: { start: string; auto: number; person: number; stopped: number }[]; // oldest first, by the run's start
  runs: number;
  cost: { p50: number; p95: number; total: number };
  time: { p50: number; p95: number }; // seconds, ended runs only
  steps: { step: string; reached: number; blocked: number; p50: number; p95: number }[]; // seconds; blocked: runs that ended blocked at this step
  targets: { target: string; runs: number; cost: number; p50: number; p95: number; week: number; budget?: number }[]; // week: cost of the current week
  rounds: { n: number; count: number }[]; // n 4 means 4 or more
  risk: { run: string; risk: number; max?: number; kind: RunKind }[];
}

const WEEK = 7 * 86_400_000;

// The nearest-rank percentile; 0 for no values.
export function pct(xs: number[], p: number) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : 0;
}

// Monday 00:00 UTC of the week that holds t.
export const weekStart = (t: number) => {
  const d = new Date(t);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000;
};

// runs: every run summary. events: the step_start, step_end and decision events of those runs.
// budgets: the weekly cost limit per target, from targets/*.yml.
export function insights(runs: RunSummary[], events: RunEvent[], now: Date, o: { weeks?: number; budgets?: Record<string, number | undefined> } = {}): Insights {
  const n = o.weeks ?? 8;
  const first = weekStart(now.getTime()) - (n - 1) * WEEK;
  const inWindow = runs.filter((r) => Date.parse(r.startedAt) >= first);
  const ids = new Set(inWindow.map((r) => r.run));
  const own = events.filter((e) => ids.has(e.run)).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const auto = new Map<string, boolean>();
  for (const e of own) if (e.type === "decision") auto.set(e.run, e.data.auto);
  const kind = (r: RunSummary): RunKind => (auto.has(r.run) ? (auto.get(r.run) ? "auto" : "person") : r.endedAt ? "stopped" : "open");

  // Each step's time: a step_end closes the open step_start of the same run and step. A step that ran twice counts twice.
  const secs = new Map<string, number[]>(STEPS.map((s) => [s, []]));
  const open = new Map<string, number>();
  const reached = new Map<string, Set<string>>(STEPS.map((s) => [s, new Set()]));
  for (const e of own) {
    if (!e.step || !secs.has(e.step)) continue;
    const key = `${e.run}/${e.step}`;
    if (e.type === "step_start") [open.set(key, Date.parse(e.at)), reached.get(e.step)!.add(e.run)];
    else if (e.type === "step_end" && open.has(key)) {
      secs.get(e.step)!.push((Date.parse(e.at) - open.get(key)!) / 1000);
      open.delete(key);
    }
  }

  const weeks = Array.from({ length: n }, (_, i) => {
    const start = first + i * WEEK;
    const of = inWindow.filter((r) => Date.parse(r.startedAt) >= start && Date.parse(r.startedAt) < start + WEEK).map(kind);
    return { start: new Date(start).toISOString(), auto: of.filter((k) => k === "auto").length, person: of.filter((k) => k === "person").length, stopped: of.filter((k) => k === "stopped").length };
  });
  const costs = inWindow.map((r) => r.costUsd);
  const times = inWindow.filter((r) => r.endedAt).map((r) => (Date.parse(r.endedAt!) - Date.parse(r.startedAt)) / 1000);
  const thisWeek = first + (n - 1) * WEEK;
  const targets = [...new Set(inWindow.map((r) => r.target))].sort().map((target) => {
    const rs = inWindow.filter((r) => r.target === target);
    const c = rs.map((r) => r.costUsd);
    const week = rs.filter((r) => Date.parse(r.startedAt) >= thisWeek).reduce((a, r) => a + r.costUsd, 0);
    return { target, runs: rs.length, cost: c.reduce((a, b) => a + b, 0), p50: pct(c, 50), p95: pct(c, 95), week, ...(o.budgets?.[target] !== undefined ? { budget: o.budgets[target] } : {}) };
  });
  return {
    weeks,
    runs: inWindow.length,
    cost: { p50: pct(costs, 50), p95: pct(costs, 95), total: costs.reduce((a, b) => a + b, 0) },
    time: { p50: pct(times, 50), p95: pct(times, 95) },
    steps: STEPS.map((step) => ({ step, reached: reached.get(step)!.size, blocked: inWindow.filter((r) => r.outcome === "blocked" && r.lastStep?.step === step).length, p50: pct(secs.get(step)!, 50), p95: pct(secs.get(step)!, 95) })),
    targets,
    rounds: [1, 2, 3, 4].map((k) => ({ n: k, count: inWindow.filter((r) => r.round !== undefined && Math.min(r.round, 4) === k).length })),
    risk: inWindow.filter((r) => r.mergeRisk !== undefined).map((r) => ({ run: r.run, risk: r.mergeRisk!, max: r.mergeRiskMax, kind: kind(r) })),
  };
}
