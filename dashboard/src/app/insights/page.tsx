import { Suspense } from "react";
import { InsightsView } from "@/components/insights-view";
import { RangePicker } from "@/components/range-picker";
import { PageTitle } from "@/components/shell";
import { getDb } from "@/server/db-instance";
import { insights, RANGES, resolveRange } from "@/server/insights";
import { readTargets } from "@/server/targets";

export const dynamic = "force-dynamic";

const EVENTS_LIMIT = 100_000; // step events per target in the range; a busy target sends about 30 a run

const day = (t: number, tz: string) => new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: tz }).format(t);

export default async function InsightsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  const now = new Date();
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
  const said = r.key === "custom" ? `${day(r.from, r.tz)} to ${day(r.to - 1, r.tz)}` : RANGES[r.key];
  return (
    <main>
      <PageTitle
        title="Insights"
        actions={
          <Suspense>
            <RangePicker range={r.key} from={"fromDay" in r ? r.fromDay : undefined} to={"toDay" in r ? r.toDay : undefined} />
          </Suspense>
        }
      >
        {said}, every target, by when each run started. Times in {r.tz}.
      </PageTitle>
      <InsightsView data={data} />
    </main>
  );
}
