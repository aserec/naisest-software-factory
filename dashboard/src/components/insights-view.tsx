import { DIFF_RISK_MAX } from "software-factory/run-events";
import type { Insights, RunKind } from "@/server/insights";
import { duration, usd, words } from "@/lib/utils";
import { SectionHeading } from "./shell";

const KINDS: [RunKind, string, string][] = [
  ["auto", "Merged without a person", "bg-data"],
  ["person", "Sent to a person", "bg-foreground/45"],
  ["stopped", "Ended without a change", "bg-raised ring-1 ring-border ring-inset"],
];
const BUDGET_WARN = 0.8; // the share of a weekly budget from which the cost turns to a warning

// Two figures a row on a phone, four from md, a rule between neighbours as on the run page.
const Figure = ({ label, value, note, className = "" }: { label: string; value: React.ReactNode; note?: string; className?: string }) => (
  <div className={`min-w-0 py-4 ${className}`}>
    <div className="text-muted-foreground">{label}</div>
    <div className="mt-1 text-2xl leading-8">{value}</div>
    {note && <div className="text-xs text-muted-foreground">{note}</div>}
  </div>
);

const day = (iso: string) => new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });

// One stacked bar per week: merged alone at the base, sent to a person, then the runs that ended without a change.
function Weeks({ weeks }: { weeks: Insights["weeks"] }) {
  const max = Math.max(1, ...weeks.map((w) => w.auto + w.person + w.stopped));
  return (
    <>
      <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {KINDS.map(([k, label, fill]) => (
          <li key={k} className="flex items-center gap-1.5">
            <span className={`size-2.5 rounded-sm ${fill}`} />
            {label}
          </li>
        ))}
      </ul>
      <ol className="flex h-40 items-end gap-2 sm:gap-3">
        {weeks.map((w) => {
          const said = `Week of ${day(w.start)}: ${w.auto} merged without a person, ${w.person} sent to a person, ${w.stopped} ended without a change`;
          return (
            <li key={w.start} title={said} aria-label={said} className="group flex h-full flex-1 flex-col items-center justify-end gap-1">
              <div className="flex h-[calc(100%-1.25rem)] w-full max-w-10 flex-col-reverse gap-0.5">
                {KINDS.map(([k, , fill]) => {
                  const n = w[k as "auto" | "person" | "stopped"];
                  return n > 0 && <div key={k} className={`rounded-sm ${fill} group-hover:opacity-80`} style={{ height: `${(n / max) * 100}%` }} />;
                })}
              </div>
              <span className="text-xs whitespace-nowrap text-muted-foreground">{day(w.start)}</span>
            </li>
          );
        })}
      </ol>
    </>
  );
}

// A p50 to p95 range on one shared scale: the band is the spread, the tick the usual run.
const Range = ({ p50, p95, max }: { p50: number; p95: number; max: number }) => (
  <span className="relative block h-2 rounded-full bg-raised">
    <span className="absolute inset-y-0 rounded-full bg-data/30" style={{ left: `${(p50 / max) * 100}%`, width: `${Math.max(((p95 - p50) / max) * 100, 0.5)}%` }} />
    <span className="absolute -inset-y-0.5 w-1 rounded-full bg-data" style={{ left: `${(p50 / max) * 100}%` }} />
  </span>
);

// The week's cost against the target's budget: a warning from 80%, red over it.
function Budget({ week, budget }: { week: number; budget?: number }) {
  if (budget === undefined) return <>{usd(week)}</>;
  const tone = week > budget ? "text-destructive" : week >= budget * BUDGET_WARN ? "text-pill-warning-ink" : "";
  return (
    <span className={tone} title={`${Math.round((week / budget) * 100)}% of the weekly budget`}>
      {usd(week)} <span className="text-muted-foreground">of {usd(budget)}</span>
    </span>
  );
}

// Merge risk against what became of the change. A dot right of the limit in the top row merged alone above it.
function Risk({ risk }: { risk: Insights["risk"] }) {
  const max = risk.find((r) => r.max !== undefined)?.max ?? DIFF_RISK_MAX;
  const x = (v: number) => `${((v - 2) / 8) * 100}%`; // Jev 2 answers 2 to 10
  return (
    <div className="flex flex-col gap-3">
      {KINDS.map(([k, label]) => {
        const dots = risk.filter((r) => r.kind === k);
        return (
          <div key={k} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] items-center gap-4">
            <span className="text-muted-foreground">
              {label} <span className="tabular-nums">{dots.length}</span>
            </span>
            <span className="relative h-6 rounded bg-raised">
              <span className="absolute inset-y-0 border-l border-dashed border-destructive" style={{ left: x(max) }} />
              {dots.map((r, i) => (
                <span key={r.run} title={`${r.run}: merge risk ${r.risk}`} className="absolute top-1/2 size-2 -translate-1/2 rounded-full bg-foreground/50 ring-2 ring-background hover:bg-data" style={{ left: x(r.risk), marginTop: `${((i % 5) - 2) * 3}px` }} />
              ))}
            </span>
          </div>
        );
      })}
      <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-4 text-xs text-muted-foreground">
        <span />
        <span className="relative h-4">
          <span className="absolute left-0">Merge risk 2</span>
          <span className="absolute -translate-x-1/2 text-destructive" style={{ left: x(max) }}>
            limit {max}
          </span>
          <span className="absolute right-0">10</span>
        </span>
      </div>
    </div>
  );
}

const th = "py-2 font-medium";

export function InsightsView({ data }: { data: Insights }) {
  if (data.runs === 0) return <p className="text-muted-foreground">No runs in these weeks yet.</p>;
  const thisWeek = data.weeks.at(-1)!;
  const merged = data.weeks.reduce((a, w) => a + w.auto, 0);
  const decided = data.weeks.reduce((a, w) => a + w.auto + w.person, 0);
  const maxStep = Math.max(1, ...data.steps.map((s) => s.p95));
  const rounded = data.rounds.reduce((a, r) => a + r.count, 0);
  return (
    <>
      <div className="mb-8 grid grid-cols-2 border-y md:grid-cols-4">
        <Figure className="pr-4" label="Merged alone this week" value={thisWeek.auto} note={`${thisWeek.person} sent to a person`} />
        <Figure className="border-l pl-4" label="Without a person" value={decided ? `${Math.round((merged / decided) * 100)}%` : "—"} note={`of ${decided} decided changes`} />
        <Figure className="border-t pr-4 md:border-t-0 md:border-l md:pl-4" label="Cost per run" value={usd(data.cost.p50)} note={`p95 ${usd(data.cost.p95)}, ${usd(data.cost.total)} in all`} />
        <Figure className="border-t border-l pl-4 md:border-t-0" label="Time per run" value={data.time.p50 ? duration(data.time.p50) : "—"} note={data.time.p95 ? `p95 ${duration(data.time.p95)}` : "No run ended yet"} />
      </div>

      <section className="mb-10">
        <SectionHeading>Runs by week</SectionHeading>
        <Weeks weeks={data.weeks} />
      </section>

      <section className="mb-10 overflow-x-auto">
        <SectionHeading>Steps</SectionHeading>
        <table className="w-full min-w-[36rem]">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className={th}>Step</th>
              <th className={`${th} text-right`}>Runs</th>
              <th className={`${th} pl-4`}>Time, p50 to p95</th>
              <th className={`${th} text-right`}>p50</th>
              <th className={`${th} text-right`}>p95</th>
              <th className={`${th} text-right`}>Blocked here</th>
            </tr>
          </thead>
          <tbody>
            {data.steps.map((s) => (
              <tr key={s.step} className="border-t border-rule">
                <td className="py-2.5 pr-4">{words(s.step)}</td>
                <td className="text-right">{s.reached || "—"}</td>
                <td className="w-1/2 pl-4">{s.reached > 0 && <Range p50={s.p50} p95={s.p95} max={maxStep} />}</td>
                <td className="pl-4 text-right">{s.reached ? duration(s.p50) : "—"}</td>
                <td className="pl-4 text-right text-muted-foreground">{s.reached ? duration(s.p95) : "—"}</td>
                <td className={`pl-4 text-right ${s.blocked ? "text-destructive" : "text-muted-foreground"}`}>{s.blocked || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="mb-10 grid gap-10 lg:grid-cols-2">
        <section className="overflow-x-auto">
          <SectionHeading>Cost by target</SectionHeading>
          <table className="w-full">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className={th}>Target</th>
                <th className={`${th} text-right`}>Runs</th>
                <th className={`${th} text-right`}>p50</th>
                <th className={`${th} text-right`}>p95</th>
                <th className={`${th} text-right`}>This week</th>
              </tr>
            </thead>
            <tbody>
              {data.targets.map((t) => (
                <tr key={t.target} className="border-t border-rule">
                  <td className="py-2.5 pr-4 font-mono text-xs">{t.target}</td>
                  <td className="text-right">{t.runs}</td>
                  <td className="pl-4 text-right">{usd(t.p50)}</td>
                  <td className="pl-4 text-right text-muted-foreground">{usd(t.p95)}</td>
                  <td className="pl-4 text-right">
                    <Budget week={t.week} budget={t.budget} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section>
          <SectionHeading>Review rounds per run</SectionHeading>
          {rounded === 0 ? (
            <p className="text-muted-foreground">No run has a review finding yet.</p>
          ) : (
            data.rounds.map((r) => (
              <div key={r.n} className="grid grid-cols-[6rem_minmax(0,1fr)_3rem] items-center gap-3 py-1.5">
                <span className="text-muted-foreground">{r.n === 4 ? "4 or more" : `${r.n} ${r.n === 1 ? "round" : "rounds"}`}</span>
                <span className="h-2 rounded-full bg-raised">
                  <span className="block h-full rounded-full bg-data" style={{ width: `${(r.count / rounded) * 100}%` }} />
                </span>
                <span className="text-right">{r.count}</span>
              </div>
            ))
          )}
        </section>
      </div>

      {data.risk.length > 0 && (
        <section>
          <SectionHeading>Merge risk against what happened</SectionHeading>
          <Risk risk={data.risk} />
        </section>
      )}
    </>
  );
}
