import { getDb } from "./db-instance";
import { insights, RANGES, resolveRange, type Insights, type RangeKey } from "./insights";
import { readTargets } from "./targets";

const EVENTS_LIMIT = 100_000; // step events per target in the range; a busy target sends about 30 a run

export interface InsightsPayload {
  data: Insights;
  range: RangeKey;
  fromDay?: string; // a custom range's dates, as the URL had them
  toDay?: string;
  said: string; // the range in words, for the line under the title
  tz: string;
}

const day = (t: number, tz: string) => new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: tz }).format(t);

// What the Insights page and /api/insights both answer for the range in a URL.
export function loadInsights(q: { range?: string; from?: string; to?: string; tz?: string }, now = new Date()): InsightsPayload {
  const r = resolveRange(q, now, q.tz);
  const db = getDb();
  const runs = db.runs({});
  const since = new Date(r.from).toISOString();
  const events = [...new Set(runs.map((x) => x.target))].flatMap((target) => db.history({ target, since, types: ["step_start", "step_end", "decision"], limit: EVENTS_LIMIT }));
  let budgets: Record<string, number | undefined> = {};
  try {
    budgets = Object.fromEntries(readTargets().map((t) => [t.name, t.weeklyBudgetUsd]));
  } catch {} // a broken targets file costs the budgets, not the page
  const data = insights(runs, events, { from: r.from, to: r.to, now, tz: r.tz, budgets });
  // The last instant the range holds, so a custom range reads "Oct 1 to Oct 15" and not "to Oct 16".
  const custom = r.key === "custom" ? { fromDay: r.fromDay, toDay: r.toDay, said: `${day(r.from, r.tz)} to ${day(r.to - 1, r.tz)}` } : { said: RANGES[r.key] };
  return { data, range: r.key, tz: r.tz, ...custom };
}
