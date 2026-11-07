"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { eventsOfType, STEPS, stepIndex, type EventType } from "software-factory/run-events";
import { Badge } from "@/components/ui/badge";
import { Sheet } from "@/components/ui/sheet";
import { capitalize, duration, usd, when, words } from "@/lib/utils";
import { CostByModel } from "./cost-by-model";
import { Fact, StepDetail, Verdict } from "./step-detail";
import { stepRowName, stepRows, type SeqEvent, type StepRow } from "./step-rows";
import type { FileLink } from "@/server/compose";
import type { RunSummary, StateChange } from "@/server/db";
import { labelState, runView } from "@/server/run-view";
import type { FactoryState, Risk } from "@/server/seams";
import { RiskPills } from "./board";
import { STATE } from "@/lib/state";
import { EarlierRuns } from "./earlier-runs";
import { LoadError, SectionHeading } from "./shell";


// Live and history are one stream (/api/events/stream): each batch it sends is appended to the query data, so the page reads one list.
// The browser reconnects by itself and sends Last-Event-ID, so nothing comes twice. Retry opens it again after the last event held.
export function useRunEvents(run: string) {
  const client = useQueryClient();
  // Only the stream fills this query; it never fetches.
  const query = useQuery<SeqEvent[]>({ queryKey: ["events", run], enabled: false, queryFn: () => client.getQueryData<SeqEvent[]>(["events", run]) ?? [] });
  const [error, setError] = useState<Error>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const key = ["events", run];
    const after = client.getQueryData<SeqEvent[]>(key)?.at(-1)?.seq ?? 0;
    const source = new EventSource(`/api/events/stream?run=${encodeURIComponent(run)}&after=${after}`);
    source.onmessage = (m) => {
      setError(undefined);
      client.setQueryData<SeqEvent[]>(key, (old = []) => [...old, ...(JSON.parse(m.data) as SeqEvent[])]);
    };
    // The run ended and went quiet: close, or the browser would reconnect.
    source.addEventListener("end", () => source.close());
    // While the browser reconnects the state is CONNECTING; CLOSED means it gave up (the server refused the stream).
    source.onerror = () => source.readyState === EventSource.CLOSED && setError(new Error("The event stream closed"));
    return () => source.close();
  }, [client, run, attempt]);
  return { ...query, error, isFetching: false, refetch: () => (setError(undefined), setAttempt((a) => a + 1)) };
}

const PILL: Record<string, "destructive" | "warning" | "secondary" | "positive"> = { blocking: "warning", next: "positive", error: "destructive", stop: "warning", stopped: "warning", waiting: "warning" };

// The step_end outcome in the words docs/how-it-works.md uses.
const OUTCOME: Record<string, string> = { next: "passed" };

// state: the work item's state, passed for the last step only. A run that ended there with "stop" waits for whatever
// that state says (approval, an answer, a fix), so the pill uses the board's name for it.
function Pills({ row, stuck, state }: { row: StepRow; stuck: boolean; state?: FactoryState }) {
  const said = row.outcome === "stop" && state ? STATE[state].toLowerCase() : row.outcome && (OUTCOME[row.outcome] ?? row.outcome);
  return (
    <>
      {stuck && <Badge variant="destructive">Stuck</Badge>}
      <Badge variant={PILL[row.outcome ?? ""] ?? "secondary"}>{said || "running"}</Badge>
    </>
  );
}

// In a narrow column (a phone, or beside the open panel): name and pills on the first line, the bar, duration and cost on the second. From a 36rem column: one line.
function StepRowLine({ row, from, span, stuck, state, selected, onSelect }: { row: StepRow; from: number; span: number; stuck: boolean; state?: FactoryState; selected: boolean; onSelect: () => void }) {
  const start = Date.parse(row.start.at);
  const end = row.end ? Date.parse(row.end.at) : from + span;
  // The production line: ended steps in ink, the live one in the data hue, a failed or stuck one in red.
  const bar = row.outcome === "error" || stuck ? "bg-destructive" : row.end ? "bg-foreground/70" : "bg-data";
  return (
    <li className="border-b border-rule last:border-0">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={selected}
        data-step-row={row.start.id}
        onClick={onSelect}
        className="-mx-2 grid w-[calc(100%+1rem)] grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 gap-y-2 rounded-md px-2 py-3 text-left hover:bg-raised aria-expanded:bg-active/60 active:scale-[0.995] @xl:flex"
      >
        <span className="col-span-2 truncate font-medium @xl:order-1 @xl:w-40 @xl:flex-none">{stepRowName(row)}</span>
        <span className="flex justify-end gap-1 @xl:order-4 @xl:w-32">
          <Pills row={row} stuck={stuck} state={state} />
        </span>
        <span className="relative h-2 rounded-full bg-raised @xl:order-2 @xl:flex-1">
          <span className={`absolute inset-y-0 rounded-full ${bar}`} style={{ left: `${((start - from) / span) * 100}%`, width: `${Math.max(((end - start) / span) * 100, 1)}%` }} />
        </span>
        <span className="text-right text-muted-foreground @xl:order-3 @xl:w-16">{duration((end - start) / 1000)}</span>
        {/* No usage: no model ran yet (a live step reports its usage at the end) or ever, so no cost, not $0.00. */}
        {!row.events.some((e) => e.type === "usage") ? <span className="text-right text-muted-foreground @xl:order-5 @xl:w-14">—</span> : <span className="text-right @xl:order-5 @xl:w-14">{usd(row.costUsd)}</span>}
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
const latest = <E,>(events: E[], key: (e: E) => string) => [...new Map(events.map((e) => [key(e), e])).values()];

// What the change carries for the person who merges it: the review, the checks, and why the factory merges or waits.
// approving: the run waits for a person to merge, so a missing proof is a warning, not a quiet "None sent".
function Proof({ events, approving }: { events: SeqEvent[]; approving: boolean }) {
  const of = <T extends EventType>(type: T) => eventsOfType(events, type);
  const findings = of("review_finding");
  const round = Math.max(0, ...findings.map((f) => f.data.round));
  const last = findings.filter((f) => f.data.round === round);
  const gates = latest(of("gate_check"), (g) => g.data.command);
  const rules = latest(of("rule_check"), (r) => r.data.rule);
  const decision = of("decision").at(-1);
  if (!findings.length && !gates.length && !rules.length && !decision) return null;
  const passed = (ok: number, all: number) => <span className={ok < all ? "text-destructive" : ""}>{ok} of {all} passed</span>;
  const reasons = decision?.data.reasons ?? [];
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

// Each state the factory set on the work item, across all its runs, with the time it set it.
// This run's changes come from its live stream; the other runs' from the server.
function StateChanges({ run, events, others }: { run: string; events: SeqEvent[]; others: StateChange[] }) {
  const mine = eventsOfType(events, "label_change").flatMap((e) => {
    const state = labelState(e.data.to);
    return state ? [{ run, at: e.at, state }] : [];
  });
  const changes = [...others.filter((c) => c.run !== run), ...mine].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  if (!changes.length) return null;
  return (
    <section className="mt-8">
      <SectionHeading>State changes</SectionHeading>
      <ol>
        {changes.map((c, n) => (
          <li key={n} className="flex flex-wrap gap-x-4 border-b border-rule py-2 last:border-0">
            <time dateTime={c.at} className="w-44 flex-none text-muted-foreground">{when(c.at)}</time>
            <span className="flex-1">{STATE[c.state]}</span>
            {c.run !== run && (
              <a href={`/runs/${encodeURIComponent(c.run)}`} className="font-mono text-xs leading-6 text-muted-foreground underline decoration-input underline-offset-4 hover:decoration-current">
                {c.run}
              </a>
            )}
          </li>
        ))}
      </ol>
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

// j and k open the next and the previous step in the side panel, as in a mail list. Typing in a field is left alone.
function useStepKeys(ids: string[], open: string | undefined, setOpen: (id: string) => void) {
  const now = useRef({ ids, open, setOpen });
  now.current = { ids, open, setOpen };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== "j" && e.key !== "k") || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target instanceof HTMLElement ? e.target : undefined;
      if (t && (t.isContentEditable || t.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])"))) return;
      const { ids, open, setOpen } = now.current;
      if (!ids.length) return;
      const i = open ? ids.indexOf(open) : -1;
      // With no step open, j starts at the first step and k at the last.
      const next = e.key === "j" ? (i < 0 ? 0 : Math.min(i + 1, ids.length - 1)) : i < 0 ? ids.length - 1 : Math.max(i - 1, 0);
      e.preventDefault();
      setOpen(ids[next]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
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

// limits: minutes per step for the run's target, read on the server.
// risk: the work item's triage risk and the run's merge risk, read on the server.
// state: the work item's state in its tracker, read on the server.
// fileLink: how a review finding links its file into the change's diff; none until the change exists.
// earlier: the work item's other runs, read on the server.
// changes: every state the factory set on the work item, read on the server; this run's own come from the stream.
export function RunTimeline({ run, limits = {}, risk = {}, state, fileLink, earlier = [], changes = [] }: { run: string; limits?: Record<string, number>; risk?: { risk?: Risk; mergeRisk?: number; mergeRiskMax?: number }; state?: FactoryState; fileLink?: FileLink; earlier?: RunSummary[]; changes?: StateChange[] }) {
  const events = useRunEvents(run);
  const { data, error } = events;
  const [openId, setOpenId] = useOpenStep();
  const nowMs = useNow();
  const rows = data ? stepRows(data) : [];
  useStepKeys(rows.map((l) => l.start.id), openId, setOpenId);
  const failed = error && <LoadError what="the run" query={events} className="mb-6" />;
  if (!data) return failed || <p className="text-muted-foreground">Loading the run…</p>;
  if (rows.length === 0) return <p className="text-muted-foreground">No steps yet.</p>;
  const times = data.map((e) => Date.parse(e.at));
  const from = Math.min(...times);
  const ended = eventsOfType(data, "run_end")[0]?.data.outcome;
  // Until the run ends, the line runs to now: a hung step keeps growing instead of reading as just started.
  // A paused run (its label says it waits for a person or the usage limit) is not working either:
  // its line ends at the last event, and the wait counts apart, so Time stays the factory's own time.
  const now = new Date(nowMs);
  const view = runView({ events: data, limits, now, fallback: state });
  const { paused } = view;
  const over = paused || view.ended;
  const last = Math.max(...times);
  const span = Math.max(Math.max(last, over ? 0 : nowMs) - from, 1);
  const live = rows.find((l) => !l.end);
  const { lastStep } = view;
  // A split step is stuck in its open round.
  const stuck = (l: StepRow) => view.stuck && !!lastStep && l.start.step === lastStep.step && (l.stepAt ?? l.start.at) === lastStep.startedAt && (!l.stepAt || !l.end);
  const open = rows.find((l) => l.start.id === openId);
  // The furthest step reached; the steps after it show as not reached.
  const reached = Math.max(...rows.map((l) => stepIndex(l.start.step)));
  const first = Math.min(...rows.map((l) => stepIndex(l.start.step)).filter((i) => i >= 0));
  const at = live ? stepIndex(live.start.step) : reached; // the last row can be a review that ran inside the gate
  const nowText = live ? stepRowName(live) : state === "needs_approval" ? "Waits for you" : (ended ?? rows.at(-1)?.outcome ?? "—");
  const step = at >= 0 && <span className="ml-2 text-muted-foreground">{at + 1} of {STEPS.length}</span>;
  const waited = paused && !view.ended && <span className="ml-2 text-base text-muted-foreground">then waiting {duration((nowMs - last) / 1000)}</span>;
  const time = (
    <>
      {duration(span / 1000)}
      {waited}
    </>
  );
  const cost = usd(rows.reduce((sum, l) => sum + l.costUsd, 0));
  const pills = (risk.risk || risk.mergeRisk !== undefined) && <RiskPills {...risk} />;
  const figures: [string, React.ReactNode][] = [
    ["Now", <span>{nowText}{step}</span>],
    ["Time", time],
    ["Cost", cost],
    ["Risk", pills || "—"],
  ];
  const approving = state === "needs_approval";
  // Why the run waits, said once at the top, so the person reads it before the merge button's consequences.
  const why = approving ? (eventsOfType(data, "decision").at(-1)?.data.reasons ?? []) : [];
  // A run that triage stopped or held says so at the top. A go needs no box: the steps after it show the run.
  const triage = eventsOfType(data, "triage_outcome").at(-1)?.data;
  const usage = eventsOfType(data, "usage").map((e) => e.data);
  // A person stopped the run, and no one resumed or restarted it since. These events have no step, so no row shows them.
  const control = data.filter((e) => e.type === "stop" || e.type === "resume" || e.type === "restart").at(-1);
  const stoppedBy = control?.type === "stop" ? control : undefined;
  return (
    <>
      {failed}
      {stoppedBy && (
        <p className="-mt-6 mb-6 text-pill-warning-ink">
          Stopped by {stoppedBy.data.user} at {when(stoppedBy.at)}.
        </p>
      )}
      {triage && triage.kind !== "go" && <Verdict outcome={triage} className="-mt-6 mb-6" />}
      {why.length > 0 && (
        <section className="-mt-6 mb-6 rounded-lg border border-pill-warning-ink/20 bg-pill-warning px-4 py-3">
          <h2 className="font-medium text-pill-warning-ink">Waits for you because</h2>
          <ul className="divide-y divide-pill-warning-ink/10">
            {why.map((reason) => (
              <li key={reason} className="py-2 text-pretty">
                {capitalize(reason)}
              </li>
            ))}
          </ul>
        </section>
      )}
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
              <span className="text-base">{step}</span>
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
            <StepRowLine key={l.start.id} row={l} from={from} span={span} stuck={stuck(l)} state={l === rows.at(-1) ? state : undefined} selected={l === open} onSelect={() => setOpenId(l === open ? undefined : l.start.id)} />
          ))}
          {STEPS.slice(reached + 1).map((s) => (
            <AheadRow key={s} step={s} />
          ))}
        </ul>
        <StateChanges run={run} events={data} others={changes} />
        {usage.length > 0 && (
          <section className="mt-8">
            <SectionHeading>Cost by model</SectionHeading>
            <CostByModel usage={usage} />
          </section>
        )}
        <EarlierRuns runs={earlier} />
      </div>
      <Sheet
        open={!!open}
        onClose={() => {
          // Back to the row the panel showed, so a keyboard user carries on from there.
          const row = document.querySelector<HTMLElement>(`[data-step-row="${CSS.escape(openId ?? "")}"]`);
          setOpenId(undefined);
          row?.focus();
        }}
        title={
          open && (
            <span className="flex flex-wrap items-center gap-2">
              {stepRowName(open)} <Pills row={open} stuck={stuck(open)} state={open === rows.at(-1) ? state : undefined} />
            </span>
          )
        }
      >
        {open && <StepDetail key={open.start.id} start={open.start} end={open.end} tools={open.tools} events={open.events} fileLink={fileLink} />}
      </Sheet>
    </>
  );
}
