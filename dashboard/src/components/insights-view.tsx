"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { DIFF_RISK_MAX } from "software-factory/run-events";
import { Badge } from "@/components/ui/badge";
import { Sheet } from "@/components/ui/sheet";
import type { Insights, RunKind, RunRow } from "@/server/insights";
import { duration, usd, words } from "@/lib/utils";
import { SectionHeading } from "./shell";

const KINDS: [RunKind, string, string][] = [
  ["auto", "Merged without a person", "bg-data"],
  ["person", "Sent to a person", "bg-foreground/45"],
  ["stopped", "Ended without a change", "bg-raised ring-1 ring-border ring-inset"],
];
const KIND_NAME: Record<RunKind, string> = { auto: "Merged without a person", person: "Sent to a person", stopped: "Ended without a change", open: "Running" };
const KIND_PILL: Record<RunKind, "positive" | "warning" | "secondary" | "default"> = { auto: "positive", person: "warning", stopped: "secondary", open: "default" };
const BUDGET_WARN = 0.8; // the share of a weekly budget from which the cost turns to a warning

// What a click on a chart opens: its runs. step: the step clicked, so each run shows its time in that step.
interface Opened {
  title: string;
  rows: RunRow[];
  step?: string;
}
type Open = (o: Opened) => void;

// Two figures a row on a phone, four from md, a rule between neighbours as on the run page.
const Figure = ({ label, value, note, className = "" }: { label: string; value: React.ReactNode; note?: string; className?: string }) => (
  <div className={`min-w-0 py-4 ${className}`}>
    <div className="text-muted-foreground">{label}</div>
    <div className="mt-1 text-2xl leading-8">{value}</div>
    {note && <div className="text-xs text-muted-foreground">{note}</div>}
  </div>
);

// Bars and dots move to their new size when the range changes. motion-reduce keeps them still.
const GROW = "transition-[height,width,left,margin,opacity] duration-500 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none";
const LABELS_SHOWN = 12; // with more bars, only every n-th bar keeps its label, so the labels do not run into each other
// Every chart part a click opens: a press, a hover tint and the focus ring.
const HIT = "cursor-pointer rounded-md outline-none hover:bg-raised focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98] aria-expanded:bg-active/60";

// One stacked bar per bucket: merged alone at the base, sent to a person, then the runs that ended without a change.
function Buckets({ buckets, unit, list, open, openTitle }: { buckets: Insights["buckets"]; unit: Insights["unit"]; list: RunRow[]; open: Open; openTitle?: string }) {
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
      <ol className={`flex h-44 items-end ${buckets.length > 20 ? "gap-0.5" : "gap-2 sm:gap-3"}`}>
        {buckets.map((w, i) => {
          const name = `${unit === "week" ? "Week of " : ""}${w.label}`;
          const said = `${name}: ${w.auto} merged without a person, ${w.person} sent to a person, ${w.stopped} ended without a change`;
          const title = `Runs started ${unit === "hour" ? "at" : unit === "month" ? "in" : "on"} ${name}`;
          return (
            <li key={i} className="h-full min-w-0 flex-1">
              <button type="button" title={said} aria-label={said} aria-haspopup="dialog" aria-expanded={openTitle === title} onClick={() => open({ title, rows: list.filter((r) => r.bucket === w.start) })} className={`group flex h-full w-full flex-col items-center justify-end gap-1 px-0.5 pt-1 ${HIT}`}>
                <span className="flex h-[calc(100%-1.25rem)] w-full max-w-10 flex-col-reverse">
                  {KINDS.map(([k, , fill]) => {
                    const n = w[k as "auto" | "person" | "stopped"];
                    return <span key={k} className={`block rounded-sm ${fill} ${GROW} group-hover:opacity-80`} style={{ height: `${(n / max) * 100}%`, marginTop: n ? 2 : 0, opacity: n ? undefined : 0 }} />;
                  })}
                </span>
                <span className={`h-4 text-xs whitespace-nowrap text-muted-foreground ${i % every ? "invisible" : ""}`}>{w.label}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </>
  );
}

// The production line: one column per step, as tall as the runs that reached it. The runs that ended blocked
// there sit on top in red, so a drop between two columns reads as where the line loses runs.
function Line({ steps, list, open, openTitle }: { steps: Insights["steps"]; list: RunRow[]; open: Open; openTitle?: string }) {
  const max = Math.max(1, ...steps.map((s) => s.reached));
  return (
    <div className="overflow-x-auto">
      <ol className="grid min-w-[52rem] grid-cols-10 gap-2">
        {steps.map((s, i) => {
          const said = `${words(s.step)}: reached by ${s.reached}, ${s.blocked} blocked here${s.reached ? `, ${duration(s.p50)} on a usual run, ${duration(s.p95)} on a slow one` : ""}`;
          const title = `Runs that reached ${words(s.step)}`;
          return (
            <li key={s.step}>
              <button type="button" title={said} aria-label={said} aria-haspopup="dialog" aria-expanded={openTitle === title} disabled={!s.reached} onClick={() => open({ title, step: s.step, rows: list.filter((r) => s.step in r.stepSecs) })} className={`group flex w-full flex-col p-1 text-left disabled:cursor-default disabled:hover:bg-transparent ${HIT}`}>
                <span className="flex h-40 flex-col justify-end">
                  <span className={`block rounded-sm bg-destructive ${GROW} group-hover:opacity-80`} style={{ height: `${(s.blocked / max) * 100}%`, marginBottom: s.blocked ? 2 : 0 }} />
                  <span className={`block rounded-sm ${i === steps.length - 1 ? "bg-data" : "bg-foreground/45"} ${GROW} group-hover:opacity-80`} style={{ height: `${((s.reached - s.blocked) / max) * 100}%` }} />
                </span>
                <span className="mt-2 block border-t pt-2">
                  <span className="block truncate text-xs font-medium">
                    {i + 1}. {words(s.step)}
                  </span>
                  <span className="block text-lg">{s.reached || "—"}</span>
                  <span className={`block text-xs ${s.blocked ? "text-destructive" : "text-muted-foreground"}`}>{s.blocked ? `${s.blocked} blocked` : "none blocked"}</span>
                  {s.reached > 0 && (
                    <span className="mt-2 block text-xs text-muted-foreground">
                      {duration(s.p50)}
                      <br />
                      p95 {duration(s.p95)}
                    </span>
                  )}
                </span>
              </button>
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
function Risk({ risk, list, open, openTitle }: { risk: Insights["risk"]; list: RunRow[]; open: Open; openTitle?: string }) {
  const max = risk.find((r) => r.max !== undefined)?.max ?? DIFF_RISK_MAX;
  const x = (v: number) => `${((v - 2) / 8) * 100}%`; // Jev 2 answers 2 to 10
  return (
    <div className="flex flex-col gap-1">
      {KINDS.map(([k, label]) => {
        const dots = risk.filter((r) => r.kind === k);
        const title = `${label}, by merge risk`;
        return (
          <button key={k} type="button" aria-haspopup="dialog" aria-expanded={openTitle === title} disabled={!dots.length} onClick={() => open({ title, rows: list.filter((r) => r.kind === k && r.mergeRisk !== undefined).sort((a, b) => b.mergeRisk! - a.mergeRisk!) })} className={`grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] items-center gap-4 px-1 py-1 text-left disabled:cursor-default disabled:hover:bg-transparent ${HIT}`}>
            <span className="text-muted-foreground">
              {label} <span className="tabular-nums">{dots.length}</span>
            </span>
            <span className="relative h-6 rounded bg-raised">
              <span className="absolute inset-y-0 border-l border-dashed border-destructive" style={{ left: x(max) }} />
              {dots.map((r, i) => (
                <span key={r.run} title={`${r.run}: merge risk ${r.risk}`} className={`absolute top-1/2 size-2 -translate-1/2 rounded-full bg-foreground/50 ring-2 ring-background ${GROW}`} style={{ left: x(r.risk), marginTop: `${((i % 5) - 2) * 3}px` }} />
              ))}
            </span>
          </button>
        );
      })}
      <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-4 px-1 text-xs text-muted-foreground">
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

const when = (iso: string) => new Date(iso).toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

// The runs behind what was clicked: a line of totals, then one row per run with a link to its run page.
function RunsList({ rows, step }: Opened) {
  const total = rows.reduce((a, r) => a + r.costUsd, 0);
  const took = (r: RunRow) => (step ? r.stepSecs[step] : r.secs);
  return (
    <>
      <p className="mb-4 text-muted-foreground">
        {rows.length} {rows.length === 1 ? "run" : "runs"}, {usd(total)} in all{step ? `. Times are the time in ${words(step)}` : ""}.
      </p>
      <ul className="flex flex-col">
        {rows.map((r) => (
          <li key={r.run} className="border-b border-rule last:border-0">
            <Link href={`/runs/${encodeURIComponent(r.run)}`} className="-mx-2 flex flex-col gap-1.5 rounded-md px-2 py-3 hover:bg-raised focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-xs">
                  {r.target} #{r.ticket}
                </span>
                <span className="flex gap-1">
                  {step && r.outcome === "blocked" && r.lastStep === step && <Badge variant="destructive">Blocked here</Badge>}
                  <Badge variant={KIND_PILL[r.kind]}>{KIND_NAME[r.kind]}</Badge>
                </span>
              </span>
              <span className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                <span>Started {when(r.startedAt)}</span>
                <span>
                  {step ? `In ${words(step)}` : "Took"} <span className="text-foreground">{took(r) ? duration(took(r)!) : step ? "still in it" : "not ended"}</span>
                </span>
                <span className="text-right">
                  Cost <span className="text-foreground">{usd(r.costUsd)}</span>
                </span>
                <span>Last step {r.lastStep ? words(r.lastStep) : "—"}</span>
                <span>{r.round !== undefined ? `${r.round} review ${r.round === 1 ? "round" : "rounds"}` : "No review findings"}</span>
                <span className="text-right">{r.mergeRisk !== undefined ? `Merge risk ${r.mergeRisk}` : ""}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

const th = "py-2 font-medium";

export function InsightsView({ data }: { data: Insights }) {
  const [opened, setOpened] = useState<Opened>();
  const from = useRef<HTMLElement | null>(null);
  if (data.runs === 0) return <p className="text-muted-foreground">No run started in this range.</p>;
  const open: Open = (o) => {
    from.current = document.activeElement as HTMLElement | null;
    setOpened((now) => (now?.title === o.title ? undefined : o)); // a second click on the same part closes it
  };
  const t = opened?.title;
  const merged = data.buckets.reduce((a, w) => a + w.auto, 0);
  const decided = data.buckets.reduce((a, w) => a + w.auto + w.person, 0);
  const rounded = data.rounds.reduce((a, r) => a + r.count, 0);
  const roundName = (n: number) => (n === 4 ? "4 or more rounds" : `${n} ${n === 1 ? "round" : "rounds"}`);
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
        <Buckets buckets={data.buckets} unit={data.unit} list={data.list} open={open} openTitle={t} />
      </section>

      <section className="mb-10">
        <SectionHeading>The line</SectionHeading>
        <p className="mb-4 text-muted-foreground">How many runs reached each step, how many it blocked, and how long it took on a usual and on a slow run. Pick a step to see its runs.</p>
        <Line steps={data.steps} list={data.list} open={open} openTitle={t} />
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
              {data.targets.map((x) => {
                const title = `Runs on ${x.target}`;
                return (
                  <tr key={x.target} className="relative border-t border-rule hover:bg-raised">
                    <td className="py-2.5 pr-4">
                      {/* The button covers the row, so the whole row opens the target's runs. */}
                      <button type="button" aria-haspopup="dialog" aria-expanded={t === title} onClick={() => open({ title, rows: data.list.filter((r) => r.target === x.target) })} className="font-mono text-xs outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:ring-2 focus-visible:after:ring-ring">
                        {x.target}
                      </button>
                    </td>
                    <td className="text-right">{x.runs}</td>
                    <td className="pl-4 text-right">{usd(x.p50)}</td>
                    <td className="pl-4 text-right text-muted-foreground">{usd(x.p95)}</td>
                    <td className="pl-4 text-right">
                      <Budget week={x.week} budget={x.budget} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
        <section>
          <SectionHeading>Review rounds per run</SectionHeading>
          {rounded === 0 ? (
            <p className="text-muted-foreground">No run has a review finding yet.</p>
          ) : (
            data.rounds.map((r) => {
              const title = `Runs with ${roundName(r.n)} of review`;
              return (
                <button key={r.n} type="button" aria-haspopup="dialog" aria-expanded={t === title} disabled={!r.count} onClick={() => open({ title, rows: data.list.filter((x) => x.round !== undefined && Math.min(x.round, 4) === r.n) })} className={`grid w-full grid-cols-[6rem_minmax(0,1fr)_3rem] items-center gap-3 px-1 py-1.5 text-left disabled:cursor-default disabled:hover:bg-transparent ${HIT}`}>
                  <span className="text-muted-foreground">{r.n === 4 ? "4 or more" : roundName(r.n)}</span>
                  <span className="h-2 rounded-full bg-raised">
                    <span className={`block h-full rounded-full bg-data ${GROW}`} style={{ width: `${(r.count / rounded) * 100}%` }} />
                  </span>
                  <span className="text-right">{r.count}</span>
                </button>
              );
            })
          )}
        </section>
      </div>

      {data.risk.length > 0 && (
        <section>
          <SectionHeading>Merge risk against what happened</SectionHeading>
          <Risk risk={data.risk} list={data.list} open={open} openTitle={t} />
        </section>
      )}

      <Sheet
        open={!!opened}
        onClose={() => {
          setOpened(undefined);
          from.current?.focus(); // back to the part that opened it, so a keyboard user carries on from there
        }}
        title={opened?.title}
      >
        {opened && <RunsList {...opened} />}
      </Sheet>
    </>
  );
}
