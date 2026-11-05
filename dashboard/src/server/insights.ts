import { STEPS, type RunEvent } from "software-factory/run-events";
import type { RunSummary } from "./db";

// What became of a run: the decision event says whether the factory merged alone or sent the change to a person.
// The dashboard does not see a person's merge, so "person" means sent to a person, not merged by one.
export type RunKind = "auto" | "person" | "stopped" | "open";
export type Unit = "hour" | "day" | "week" | "month";

export interface Insights {
  unit: Unit; // how long one bar of buckets is
  buckets: { start: string; label: string; auto: number; person: number; stopped: number }[]; // oldest first, by the run's start
  runs: number;
  cost: { p50: number; p95: number; total: number };
  time: { p50: number; p95: number }; // seconds, ended runs only
  steps: { step: string; reached: number; blocked: number; p50: number; p95: number }[]; // seconds; blocked: runs that ended blocked at this step
  targets: { target: string; runs: number; cost: number; p50: number; p95: number; week: number; budget?: number }[]; // week: cost of the current week, whatever the range
  rounds: { n: number; count: number }[]; // n 4 means 4 or more
  risk: { run: string; risk: number; max?: number; kind: RunKind }[];
  list: RunRow[]; // every run in the range, newest first, for the panel a click on a chart opens
}

// One run as the panel lists it. bucket: the start of the bar it counts in. stepSecs: its time in each step it reached.
export interface RunRow {
  run: string;
  target: string;
  ticket: string;
  startedAt: string;
  secs?: number; // start to end, once ended
  costUsd: number;
  kind: RunKind;
  outcome?: string;
  lastStep?: string;
  round?: number;
  mergeRisk?: number;
  bucket: string;
  stepSecs: Record<string, number>;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// The nearest-rank percentile; 0 for no values.
export function pct(xs: number[], p: number) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : 0;
}

// ---------- wall time in the viewer's time zone, with Intl only ----------

export function validZone(tz?: string) {
  try {
    return tz ? (new Intl.DateTimeFormat("en", { timeZone: tz }), tz) : "UTC";
  } catch {
    return "UTC";
  }
}

const formats = new Map<string, Intl.DateTimeFormat>();
// The wall time of instant t in tz: year, month 1 to 12, day, hour, minute.
export function local(t: number, tz: string) {
  let f = formats.get(tz);
  if (!f) formats.set(tz, (f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })));
  const p = Object.fromEntries(f.formatToParts(t).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, m: p.month, d: p.day, h: p.hour, mi: p.minute };
}

// The instant of a wall time in tz. The second pass corrects a guess that landed across a daylight saving change.
export function instant(tz: string, y: number, m: number, d: number, h = 0) {
  const want = Date.UTC(y, m - 1, d, h);
  let t = want;
  for (let i = 0; i < 2; i++) {
    const l = local(t, tz);
    t += want - Date.UTC(l.y, l.m - 1, l.d, l.h, l.mi);
  }
  return t;
}

// The start of the hour, day, week (Monday) or month that holds t, in tz.
export function bucketStart(t: number, tz: string, unit: Unit) {
  const l = local(t, tz);
  if (unit === "hour") return instant(tz, l.y, l.m, l.d, l.h);
  if (unit === "month") return instant(tz, l.y, l.m, 1);
  if (unit === "day") return instant(tz, l.y, l.m, l.d);
  const monday = new Date(Date.UTC(l.y, l.m - 1, l.d - ((new Date(Date.UTC(l.y, l.m - 1, l.d)).getUTCDay() + 6) % 7)));
  return instant(tz, monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate());
}

// ---------- the range a person picks ----------

export const RANGES = { today: "Today", yesterday: "Yesterday", "24h": "Last 24 hours", "7d": "Last 7 days", "30d": "Last 30 days", year: "This year", custom: "From a date to a date" } as const;
export type RangeKey = keyof typeof RANGES;
export const DEFAULT_RANGE: RangeKey = "7d";

const isDay = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const ymd = (s: string) => s.split("-").map(Number) as [number, number, number];

// The range in the URL as two instants, from included and to excluded. A custom range runs from the start of its
// first day to the end of its last day, both in tz; dates the wrong way round swap, and a bad one falls back to the default.
export function resolveRange(q: { range?: string; from?: string; to?: string }, now: Date, tzIn?: string) {
  const tz = validZone(tzIn);
  const t = now.getTime();
  const l = local(t, tz);
  const today = instant(tz, l.y, l.m, l.d);
  let key = (q.range && q.range in RANGES ? q.range : DEFAULT_RANGE) as RangeKey;
  if (key === "custom" && !(isDay(q.from) && isDay(q.to))) key = DEFAULT_RANGE;
  if (key === "custom") {
    const [a, b] = [q.from!, q.to!].sort();
    const [y2, m2, d2] = ymd(b);
    return { key, tz, from: instant(tz, ...ymd(a)), to: instant(tz, y2, m2, d2 + 1), fromDay: a, toDay: b };
  }
  const from = { today, yesterday: instant(tz, l.y, l.m, l.d - 1), "24h": t - DAY, "7d": t - 7 * DAY, "30d": t - 30 * DAY, year: instant(tz, l.y, 1, 1) }[key];
  return { key, tz, from, to: key === "yesterday" ? today : t };
}

// Bars an hour long up to two days, a day up to two months, a week up to about half a year, else a month.
export const unitOf = (span: number): Unit => (span <= 2 * DAY ? "hour" : span <= 62 * DAY ? "day" : span <= 200 * DAY ? "week" : "month");

function label(t: number, tz: string, unit: Unit) {
  const o: Intl.DateTimeFormatOptions = unit === "hour" ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : unit === "month" ? { month: "short", year: "2-digit" } : { month: "short", day: "numeric" };
  return new Intl.DateTimeFormat("en", { ...o, timeZone: tz }).format(t);
}

// runs: every run summary. events: the step_start, step_end and decision events of those runs.
// from, to: the range, as instants; a run counts when it started in it. budgets: the weekly cost limit per target.
export function insights(runs: RunSummary[], events: RunEvent[], o: { from: number; to: number; now: Date; tz?: string; budgets?: Record<string, number | undefined> }): Insights {
  const tz = validZone(o.tz);
  const started = (r: RunSummary) => Date.parse(r.startedAt);
  const inRange = runs.filter((r) => started(r) >= o.from && started(r) < o.to);
  const ids = new Set(inRange.map((r) => r.run));
  const own = events.filter((e) => ids.has(e.run)).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const auto = new Map<string, boolean>();
  for (const e of own) if (e.type === "decision") auto.set(e.run, e.data.auto);
  const kind = (r: RunSummary): RunKind => (auto.has(r.run) ? (auto.get(r.run) ? "auto" : "person") : r.endedAt ? "stopped" : "open");

  // Each step's time: a step_end closes the open step_start of the same run and step. A step that ran twice counts twice.
  const secs = new Map<string, number[]>(STEPS.map((s) => [s, []]));
  const open = new Map<string, number>();
  const reached = new Map<string, Set<string>>(STEPS.map((s) => [s, new Set()]));
  const perRun = new Map<string, Record<string, number>>(inRange.map((r) => [r.run, {}]));
  for (const e of own) {
    if (!e.step || !secs.has(e.step)) continue;
    const key = `${e.run}/${e.step}`;
    if (e.type === "step_start") [open.set(key, Date.parse(e.at)), reached.get(e.step)!.add(e.run), (perRun.get(e.run)![e.step] ??= 0)];
    else if (e.type === "step_end" && open.has(key)) {
      const took = (Date.parse(e.at) - open.get(key)!) / 1000;
      secs.get(e.step)!.push(took);
      const mine = perRun.get(e.run)!;
      mine[e.step] = (mine[e.step] ?? 0) + took;
      open.delete(key);
    }
  }

  // Every bucket the range touches, empty ones too. ponytail: walks the range an hour at a time, about 9,000 steps for a year; step by unit if a range ever spans years.
  const unit = unitOf(o.to - o.from);
  const starts = new Set<number>();
  for (let t = o.from; t < o.to; t += HOUR) starts.add(bucketStart(t, tz, unit));
  if (o.to > o.from) starts.add(bucketStart(o.to - 1, tz, unit));
  const byBucket = new Map([...starts].map((s) => [s, { start: new Date(s).toISOString(), label: label(s, tz, unit), auto: 0, person: 0, stopped: 0 }]));
  for (const r of inRange) {
    const b = byBucket.get(bucketStart(started(r), tz, unit));
    const k = kind(r);
    if (b && k !== "open") b[k]++;
  }

  const costs = inRange.map((r) => r.costUsd);
  const times = inRange.filter((r) => r.endedAt).map((r) => (Date.parse(r.endedAt!) - started(r)) / 1000);
  const thisWeek = bucketStart(o.now.getTime(), tz, "week");
  const targets = [...new Set(inRange.map((r) => r.target))].sort().map((target) => {
    const c = inRange.filter((r) => r.target === target).map((r) => r.costUsd);
    const week = runs.filter((r) => r.target === target && started(r) >= thisWeek).reduce((a, r) => a + r.costUsd, 0);
    return { target, runs: c.length, cost: c.reduce((a, b) => a + b, 0), p50: pct(c, 50), p95: pct(c, 95), week, ...(o.budgets?.[target] !== undefined ? { budget: o.budgets[target] } : {}) };
  });
  return {
    unit,
    buckets: [...byBucket.values()].sort((a, b) => (a.start < b.start ? -1 : 1)),
    runs: inRange.length,
    cost: { p50: pct(costs, 50), p95: pct(costs, 95), total: costs.reduce((a, b) => a + b, 0) },
    time: { p50: pct(times, 50), p95: pct(times, 95) },
    steps: STEPS.map((step) => ({ step, reached: reached.get(step)!.size, blocked: inRange.filter((r) => r.outcome === "blocked" && r.lastStep?.step === step).length, p50: pct(secs.get(step)!, 50), p95: pct(secs.get(step)!, 95) })),
    targets,
    rounds: [1, 2, 3, 4].map((k) => ({ n: k, count: inRange.filter((r) => r.round !== undefined && Math.min(r.round, 4) === k).length })),
    risk: inRange.filter((r) => r.mergeRisk !== undefined).map((r) => ({ run: r.run, risk: r.mergeRisk!, max: r.mergeRiskMax, kind: kind(r) })),
    list: [...inRange]
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
      .map((r) => ({
        run: r.run, target: r.target, ticket: r.ticket, startedAt: r.startedAt, costUsd: r.costUsd, kind: kind(r), bucket: new Date(bucketStart(started(r), tz, unit)).toISOString(), stepSecs: perRun.get(r.run)!,
        ...(r.endedAt ? { secs: (Date.parse(r.endedAt) - started(r)) / 1000 } : {}),
        ...(r.outcome ? { outcome: r.outcome } : {}), ...(r.lastStep ? { lastStep: r.lastStep.step } : {}), ...(r.round !== undefined ? { round: r.round } : {}), ...(r.mergeRisk !== undefined ? { mergeRisk: r.mergeRisk } : {}),
      })),
  };
}
