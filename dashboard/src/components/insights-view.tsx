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

const LABELS_SHOWN = 12; // with more bars, only every n-th bar keeps its label, so the labels do not run into each other

// One stacked bar per bucket: merged alone at the base, sent to a person, then the runs that ended without a change.
function Buckets({ buckets, unit }: { buckets: Insights["buckets"]; unit: Insights["unit"] }) {
  const max = Math.max(1, ...buckets.map((w) => w.auto + w.person + w.stopped));
  const every = Math.ceil(buckets.length / LABELS_SHOWN);
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
      <ol className={`flex h-40 items-end ${buckets.length > 20 ? "gap-0.5" : "gap-2 sm:gap-3"}`}>
        {buckets.map((w, i) => {
          const said = `${unit === "week" ? "Week of " : ""}${w.label}: ${w.auto} merged without a person, ${w.person} sent to a person, ${w.stopped} ended without a change`;
          return (
            <li key={w.start} title={said} aria-label={said} className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
              <div className="flex h-[calc(100%-1.25rem)] w-full max-w-10 flex-col-reverse gap-0.5">
                {KINDS.map(([k, , fill]) => {
                  const n = w[k as "auto" | "person" | "stopped"];
                  return n > 0 && <div key={k} className={`rounded-sm ${fill} group-hover:opacity-80`} style={{ height: `${(n / max) * 100}%` }} />;
                })}
              </div>
              <span className={`h-4 text-xs whitespace-nowrap text-muted-foreground ${i % every ? "invisible" : ""}`}>{w.label}</span>
            </li>
          );
        })}
      </ol>
    </>
  );
}

// The production line: one column per step, as tall as the runs that reached it. The runs that ended blocked
// there sit on top in red, so a drop between two columns reads as where the line loses runs.
function Line({ steps }: { steps: Insights["steps"] }) {
  const max = Math.max(1, ...steps.map((s) => s.reached));
  return (
    <div className="overflow-x-auto">
      <ol className="grid min-w-[52rem] grid-cols-10 gap-2">
        {steps.map((s, i) => {
          const said = `${words(s.step)}: reached by ${s.reached}, ${s.blocked} blocked here${s.reached ? `, ${duration(s.p50)} on a usual run, ${duration(s.p95)} on a slow one` : ""}`;
          return (
            <li key={s.step} title={said} aria-label={said} className="group flex flex-col">
              <div className="flex h-40 flex-col justify-end gap-0.5">
                {s.blocked > 0 && <div className="rounded-sm bg-destructive group-hover:opacity-80" style={{ height: `${(s.blocked / max) * 100}%` }} />}
                {s.reached - s.blocked > 0 && <div className={`rounded-sm ${i === steps.length - 1 ? "bg-data" : "bg-foreground/45"} group-hover:opacity-80`} style={{ height: `${((s.reached - s.blocked) / max) * 100}%` }} />}
              </div>
              <div className="mt-2 border-t pt-2">
                <div className="truncate text-xs font-medium">
                  {i + 1}. {words(s.step)}
                </div>
                <div className="text-lg">{s.reached || "—"}</div>
                <div className={`text-xs ${s.blocked ? "text-destructive" : "text-muted-foreground"}`}>{s.blocked ? `${s.blocked} blocked` : "none blocked"}</div>
                {s.reached > 0 && (
                  <div className="mt-2 text-xs text-muted-foreground">
                    {duration(s.p50)}
                    <br />
                    p95 {duration(s.p95)}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

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
  if (data.runs === 0) return <p className="text-muted-foreground">No run started in this range.</p>;
  const merged = data.buckets.reduce((a, w) => a + w.auto, 0);
  const decided = data.buckets.reduce((a, w) => a + w.auto + w.person, 0);
  const rounded = data.rounds.reduce((a, r) => a + r.count, 0);
  return (
    <>
      <div className="mb-8 grid grid-cols-2 border-y md:grid-cols-4">
        <Figure className="pr-4" label="Merged alone" value={merged} note={`${decided - merged} sent to a person, ${data.runs} runs`} />
        <Figure className="border-l pl-4" label="Without a person" value={decided ? `${Math.round((merged / decided) * 100)}%` : "—"} note={`of ${decided} decided changes`} />
        <Figure className="border-t pr-4 md:border-t-0 md:border-l md:pl-4" label="Cost per run" value={usd(data.cost.p50)} note={`p95 ${usd(data.cost.p95)}, ${usd(data.cost.total)} in all`} />
        <Figure className="border-t border-l pl-4 md:border-t-0" label="Time per run" value={data.time.p50 ? duration(data.time.p50) : "—"} note={data.time.p95 ? `p95 ${duration(data.time.p95)}` : "No run ended yet"} />
      </div>

      <section className="mb-10">
        <SectionHeading>Runs by {data.unit}</SectionHeading>
        <Buckets buckets={data.buckets} unit={data.unit} />
      </section>

      <section className="mb-10">
        <SectionHeading>The line</SectionHeading>
        <p className="mb-4 text-muted-foreground">How many runs reached each step, how many it blocked, and how long it took on a usual and on a slow run.</p>
        <Line steps={data.steps} />
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
