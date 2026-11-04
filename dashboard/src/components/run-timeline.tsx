"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { STEPS, type RunEvent } from "software-factory/run-events";
import { Badge } from "@/components/ui/badge";
import { Sheet } from "@/components/ui/sheet";
import { duration, usd, words } from "@/lib/utils";
import { Fact, StepDetail } from "./step-detail";
import type { FactoryState } from "@/server/seams";
import { RiskPills, STATE } from "./board";
import { LoadError, SectionHeading } from "./shell";
import { isStuck } from "./stuck";

export type SeqEvent = RunEvent & { seq: number };

// Live and history are one query: ask after the last cursor and append what comes back.
export function useRunEvents(run: string) {
  const cursor = useRef(0);
  const all = useRef<SeqEvent[]>([]);
  return useQuery({
    queryKey: ["events", run],
    refetchInterval: 1000,
    queryFn: async () => {
      const r = await fetch(`/api/events?run=${encodeURIComponent(run)}&after=${cursor.current}`);
      if (!r.ok) throw new Error(`The events answered ${r.status}`);
      const body = (await r.json()) as { events: SeqEvent[]; cursor: number };
      cursor.current = body.cursor;
      return (all.current = [...all.current, ...body.events]);
    },
  });
}

export interface Lane {
  start: SeqEvent;
  end?: SeqEvent;
  outcome?: string;
  tools: SeqEvent[];
  events: SeqEvent[]; // the step's other events (findings, checks, usage ...)
  costUsd: number;
}

// One lane per step_start. A step_end closes the first open lane of its step. Tool calls hang on their lane by parent.
export function lanes(events: SeqEvent[]): Lane[] {
  const sorted = [...events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.seq - b.seq));
  const out: Lane[] = sorted
    .filter((e) => e.type === "step_start")
    .map((start) => ({ start, tools: sorted.filter((e) => e.type === "tool_call" && e.parent === start.id), events: [], costUsd: 0 }));
  for (const e of sorted.filter((e) => e.type === "step_end")) {
    const lane = out.find((l) => !l.end && l.start.step === e.step && l.start.at <= e.at);
    if (lane) [lane.end, lane.outcome] = [e, e.data.outcome as string];
  }
  const own = new Set(["step_start", "step_end", "tool_call"]);
  for (const lane of out) {
    lane.events = sorted.filter((e) => !own.has(e.type) && e.step === lane.start.step && e.at >= lane.start.at && (!lane.end || e.at <= lane.end.at));
    lane.costUsd = lane.events.filter((e) => e.type === "usage").reduce((sum, e) => sum + (e.data.costUsd as number), 0);
  }
  return out;
}

const PILL: Record<string, "destructive" | "warning" | "secondary"> = { error: "destructive", stop: "warning", stopped: "warning", waiting: "warning" };

// The step_end outcome in the words docs/how-it-works.md uses.
const OUTCOME: Record<string, string> = { next: "passed" };

// state: the work item's state, passed for the last step only. A run that ended there with "stop" waits for whatever
// that state says (approval, an answer, a fix), so the pill uses the board's name for it.
function Pills({ lane, stuck, state }: { lane: Lane; stuck: boolean; state?: FactoryState }) {
  const said = lane.outcome === "stop" && state ? STATE[state].toLowerCase() : lane.outcome && (OUTCOME[lane.outcome] ?? lane.outcome);
  return (
    <>
      {stuck && <Badge variant="destructive">Stuck</Badge>}
      <Badge variant={PILL[lane.outcome ?? ""] ?? "secondary"}>{said || "running"}</Badge>
    </>
  );
}

// In a narrow column (a phone, or beside the open panel): name and pills on the first line, the bar, duration and cost on the second. From a 36rem column: one line.
function LaneRow({ lane, from, span, stuck, state, selected, onSelect }: { lane: Lane; from: number; span: number; stuck: boolean; state?: FactoryState; selected: boolean; onSelect: () => void }) {
  const start = Date.parse(lane.start.at);
  const end = lane.end ? Date.parse(lane.end.at) : from + span;
  // The production line: ended steps in ink, the live one in the data hue, a failed or stuck one in red.
  const bar = lane.outcome === "error" || stuck ? "bg-destructive" : lane.end ? "bg-foreground/70" : "bg-data";
  return (
    <li className="border-b border-rule last:border-0">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={selected}
        data-lane={lane.start.id}
        onClick={onSelect}
        className="-mx-2 grid w-[calc(100%+1rem)] grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 gap-y-2 rounded-md px-2 py-3 text-left hover:bg-raised aria-expanded:bg-active/60 active:scale-[0.995] @xl:flex"
      >
        <span className="col-span-2 truncate font-medium @xl:order-1 @xl:w-40 @xl:flex-none">{words(lane.start.step ?? "")}</span>
        <span className="flex justify-end gap-1 @xl:order-4 @xl:w-32">
          <Pills lane={lane} stuck={stuck} state={state} />
        </span>
        <span className="relative h-2 rounded-full bg-raised @xl:order-2 @xl:flex-1">
          <span className={`absolute inset-y-0 rounded-full ${bar}`} style={{ left: `${((start - from) / span) * 100}%`, width: `${Math.max(((end - start) / span) * 100, 1)}%` }} />
        </span>
        <span className="text-right text-muted-foreground @xl:order-3 @xl:w-16">{duration((end - start) / 1000)}</span>
        {/* A live step reports its usage at the end, so until then its cost is unknown, not $0.00. */}
        {!lane.end && lane.costUsd === 0 ? <span className="text-right text-muted-foreground @xl:order-5 @xl:w-14">—</span> : <span className="text-right @xl:order-5 @xl:w-14">{usd(lane.costUsd)}</span>}
      </button>
    </li>
  );
}

const Figure = ({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) => (
  <div className={`min-w-0 py-4 ${className}`}>
    <div className="text-muted-foreground">{label}</div>
    <div className="mt-1 truncate text-2xl leading-8">{children}</div>
  </div>
);

// The newest event per key: a gate or rule check that ran again counts once, with its last result.
const latest = (events: SeqEvent[], key: string) => [...new Map(events.map((e) => [e.data[key], e])).values()];

// What the change carries for the person who merges it: the review, the checks, and why the factory merges or waits.
// approving: the run waits for a person to merge, so a missing proof is a warning, not a quiet "None sent".
function Proof({ events, approving }: { events: SeqEvent[]; approving: boolean }) {
  const of = (type: SeqEvent["type"]) => events.filter((e) => e.type === type);
  const findings = of("review_finding");
  const round = Math.max(0, ...findings.map((f) => f.data.round as number));
  const last = findings.filter((f) => f.data.round === round);
  const gates = latest(of("gate_check"), "command");
  const rules = latest(of("rule_check"), "rule");
  const decision = of("decision").at(-1);
  if (!findings.length && !gates.length && !rules.length && !decision) return null;
  const passed = (ok: number, all: number) => <span className={ok < all ? "text-destructive" : ""}>{ok} of {all} passed</span>;
  const reasons = (decision?.data.reasons as string[] | undefined) ?? [];
  const none = (what: string, todo: string) =>
    approving ? <span className="text-pill-warning-ink">The run sent no {what}. {todo} before you merge.</span> : <span className="text-muted-foreground">None sent</span>;
  return (
    <section className="mb-8">
      <SectionHeading>Proof</SectionHeading>
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-2">
        {/* Every row shows, so a missing proof reads as missing and not as hidden. */}
        <Fact label="Review">
          {last.length ? `Round ${round}, ${last.filter((f) => f.data.blocking).length} of ${last.length} ${last.length === 1 ? "finding" : "findings"} blocking` : none("review findings", "Read the diff yourself")}
        </Fact>
        <Fact label="Checks">{gates.length ? passed(gates.filter((g) => g.data.exitCode === 0).length, gates.length) : none("check results", "Look at the run's jobs")}</Fact>
        <Fact label="Rules">{rules.length ? passed(rules.filter((r) => r.data.passed).length, rules.length) : none("rule results", "Look at the changed files")}</Fact>
        {/* On an approval run the line under the title already says why it waits. */}
        {decision && !approving && (
          <Fact label="Decision">
            {decision.data.auto ? "Merges without a person" : "Waits for a person"}
            {reasons.length ? `, because ${reasons.join(", and ")}` : ""}.
          </Fact>
        )}
      </dl>
    </section>
  );
}

// A step with no events in this run: its name and an empty track, so the whole line of ten steps shows.
// before: a step ahead of the first recorded one, such as a run continued in a new CI run. It ran, but sent no events here.
function AheadRow({ step, before = false }: { step: string; before?: boolean }) {
  return (
    <li className="border-b border-rule text-muted-foreground last:border-0">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 py-3 @xl:flex">
        <span className="truncate @xl:w-40 @xl:flex-none">
          {words(step)}
          <span className="sr-only">{before ? ", no events in this run" : " not reached"}</span>
        </span>
        <span className="hidden h-2 rounded-full bg-raised @xl:block @xl:flex-1" />
        {/* As tall as a pill, so this row matches a reached row's height. */}
        <span aria-hidden className="h-5.5 text-right text-xs leading-5.5 @xl:w-[17.5rem]">
          {before && "no events"}
        </span>
      </div>
    </li>
  );
}

// The open step lives in the URL (?step=<id>), so a link to a step's log can be shared.
function useOpenStep() {
  const [open, setOpen] = useState<string>();
  useEffect(() => setOpen(new URLSearchParams(window.location.search).get("step") ?? undefined), []);
  const set = (id?: string) => {
    setOpen(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("step", id);
    else url.searchParams.delete("step");
    window.history.replaceState(null, "", url);
  };
  return [open, set] as const;
}

// The clock a live run counts against, ticking each second.
function useNow() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

// The states of a run that halted before a final state and waits to go on.
const PAUSED: FactoryState[] = ["needs_approval", "needs_info", "stopped", "blocked", "waiting"];

// limits: minutes per step for the run's target, read on the server.
// risk: the work item's triage risk and the run's merge risk, read on the server.
// state: the work item's state in its tracker, read on the server.
export function RunTimeline({ run, limits = {}, risk = {}, state }: { run: string; limits?: Record<string, number>; risk?: { risk?: string; mergeRisk?: number; mergeRiskMax?: number }; state?: FactoryState }) {
  const events = useRunEvents(run);
  const { data, error } = events;
  const [openId, setOpenId] = useOpenStep();
  const nowMs = useNow();
  const failed = error && <LoadError what="the run" query={events} className="mb-6" />;
  if (!data) return failed || <p className="text-muted-foreground">Loading the run…</p>;
  const rows = lanes(data);
  if (rows.length === 0) return <p className="text-muted-foreground">No steps yet.</p>;
  const times = data.map((e) => Date.parse(e.at));
  const from = Math.min(...times);
  const ended = data.find((e) => e.type === "run_end")?.data.outcome as string | undefined;
  // Until the run ends, the line runs to now: a hung step keeps growing instead of reading as just started.
  // A paused run (its label says it waits for a person or the usage limit) is not working either:
  // its line ends at the last event, and the wait counts apart, so Time stays the factory's own time.
  const paused = !!state && PAUSED.includes(state);
  const over = paused || data.some((e) => e.type === "run_end");
  const last = Math.max(...times);
  const span = Math.max(Math.max(last, over ? 0 : nowMs) - from, 1);
  const live = rows.find((l) => !l.end);
  const now = new Date(nowMs);
  const stuck = (l: Lane) => !over && !l.end && isStuck({ step: l.start.step ?? "", startedAt: l.start.at, ended: false }, limits, now);
  const open = rows.find((l) => l.start.id === openId);
  // The furthest step reached; the steps after it show as not reached.
  const reached = Math.max(...rows.map((l) => STEPS.indexOf(l.start.step ?? "")));
  const first = Math.min(...rows.map((l) => STEPS.indexOf(l.start.step ?? "")).filter((i) => i >= 0));
  const at = STEPS.indexOf((live ?? rows.at(-1)!).start.step ?? "");
  const nowText = live ? words(live.start.step ?? "") : state === "needs_approval" ? "Waits for you" : (ended ?? rows.at(-1)?.outcome ?? "—");
  const step = at >= 0 && <span className="ml-2 text-base text-muted-foreground">{at + 1} of {STEPS.length}</span>;
  const waited = paused && !data.some((e) => e.type === "run_end") && <span className="ml-2 text-base text-muted-foreground">then waiting {duration((nowMs - last) / 1000)}</span>;
  const time = (
    <>
      {duration(span / 1000)}
      {waited}
    </>
  );
  const cost = usd(rows.reduce((sum, l) => sum + l.costUsd, 0));
  const pills = (risk.risk || risk.mergeRisk !== undefined) && <RiskPills {...risk} />;
  const figures: [string, React.ReactNode][] = [
    ["Now", <span>{nowText}{at >= 0 && <span className="ml-2 text-muted-foreground">{at + 1} of {STEPS.length}</span>}</span>],
    ["Time", time],
    ["Cost", cost],
    ["Risk", pills || "—"],
  ];
  const approving = state === "needs_approval";
  // Why the run waits, said once at the top, so the person reads it before the merge button's consequences.
  const why = approving ? ((data.filter((e) => e.type === "decision").at(-1)?.data.reasons as string[] | undefined) ?? []) : [];
  return (
    <>
      {failed}
      {why.length > 0 && <p className="-mt-6 mb-6 text-pretty">Waits for you because {why.join(", and ")}.</p>}
      {/* The page pads itself for the open panel (main in runs/[run]/page.tsx), so the title row moves too. */}
      <div className="@container" data-panel={open ? "open" : undefined}>
        {open ? (
          // Beside the open panel the column is narrow, so the four figures share one wrapping line instead of three rows.
          <dl className="mb-8 flex flex-wrap items-center gap-x-6 gap-y-2 border-y py-3">
            {figures.map(([label, value]) => (
              <div key={label} className="flex min-w-0 items-center gap-2">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="flex flex-wrap items-center gap-2">{value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <div className="mb-8 grid grid-cols-2 border-y @3xl:grid-cols-4">
            <Figure label="Now" className="col-span-2 border-b pr-4 @3xl:col-span-1 @3xl:border-b-0">
              {nowText}
              {step}
            </Figure>
            <Figure label="Time" className="pr-4 @3xl:border-l @3xl:pl-4">
              {time}
            </Figure>
            <Figure label="Cost" className="border-l pl-4 @3xl:pr-4">
              {cost}
            </Figure>
            <Figure label="Risk" className="col-span-2 border-t @3xl:col-span-1 @3xl:border-t-0 @3xl:border-l @3xl:pl-4">
              {pills ? <span className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1">{pills}</span> : "—"}
            </Figure>
          </div>
        )}
        <Proof events={data} approving={approving} />
        <SectionHeading className="mb-0">Steps</SectionHeading>
        <ul>
          {STEPS.slice(0, Number.isFinite(first) ? first : 0).map((s) => (
            <AheadRow key={s} step={s} before />
          ))}
          {rows.map((l) => (
            <LaneRow key={l.start.id} lane={l} from={from} span={span} stuck={stuck(l)} state={l === rows.at(-1) ? state : undefined} selected={l === open} onSelect={() => setOpenId(l === open ? undefined : l.start.id)} />
          ))}
          {STEPS.slice(reached + 1).map((s) => (
            <AheadRow key={s} step={s} />
          ))}
        </ul>
      </div>
      <Sheet
        open={!!open}
        onClose={() => {
          // Back to the row the panel showed, so a keyboard user carries on from there.
          const row = document.querySelector<HTMLElement>(`[data-lane="${CSS.escape(openId ?? "")}"]`);
          setOpenId(undefined);
          row?.focus();
        }}
        title={
          open && (
            <span className="flex flex-wrap items-center gap-2">
              {words(open.start.step ?? "")} <Pills lane={open} stuck={stuck(open)} state={open === rows.at(-1) ? state : undefined} />
            </span>
          )
        }
      >
        {open && <StepDetail key={open.start.id} start={open.start} end={open.end} tools={open.tools} events={open.events} />}
      </Sheet>
    </>
  );
}
