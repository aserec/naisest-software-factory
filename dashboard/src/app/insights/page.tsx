import { InsightsView } from "@/components/insights-view";
import { PageTitle } from "@/components/shell";
import { getDb } from "@/server/db-instance";
import { insights, weekStart } from "@/server/insights";
import { readTargets } from "@/server/targets";

export const dynamic = "force-dynamic";

const WEEKS = 8;
const EVENTS_LIMIT = 100_000; // step events per target in the window; a busy target sends about 30 a run

export default async function InsightsPage() {
  const now = new Date();
  const since = new Date(weekStart(now.getTime()) - (WEEKS - 1) * 7 * 86_400_000).toISOString();
  const db = getDb();
  const runs = db.runs({});
  const events = [...new Set(runs.map((r) => r.target))].flatMap((target) => db.history({ target, since, types: ["step_start", "step_end", "decision"], limit: EVENTS_LIMIT }));
  let budgets: Record<string, number | undefined> = {};
  try {
    budgets = Object.fromEntries(readTargets().map((t) => [t.name, t.weeklyBudgetUsd]));
  } catch {} // a broken targets file costs the budgets, not the page
  const data = insights(runs, events, now, { weeks: WEEKS, budgets });
  return (
    <main>
      <PageTitle title="Insights">
        The last {WEEKS} weeks of runs, every target, by the week each run started.
      </PageTitle>
      <InsightsView data={data} />
    </main>
  );
}
