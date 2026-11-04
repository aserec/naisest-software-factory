"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { RunEvent } from "software-factory/run-events";
import { Badge } from "@/components/ui/badge";
import { Sheet } from "@/components/ui/sheet";
import { duration, usd } from "@/lib/utils";
import { StepDetail } from "./step-detail";
import { SectionHeading } from "./shell";
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

function Pills({ lane, stuck }: { lane: Lane; stuck: boolean }) {
  return (
    <>
      {stuck && <Badge variant="destructive">Stuck</Badge>}
      <Badge variant={PILL[lane.outcome ?? ""] ?? "secondary"}>{lane.outcome ?? "running"}</Badge>
    </>
  );
}

// In a narrow column (a phone, or beside the open panel): name and pills on the first line, the bar, duration and cost on the second. From a 36rem column: one line.
function LaneRow({ lane, from, span, stuck, selected, onSelect }: { lane: Lane; from: number; span: number; stuck: boolean; selected: boolean; onSelect: () => void }) {
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
        onClick={onSelect}
        className="-mx-2 grid w-[calc(100%+1rem)] grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 gap-y-2 rounded-md px-2 py-3 text-left hover:bg-raised aria-expanded:bg-active/60 active:scale-[0.995] @xl:flex"
      >
        <span className="col-span-2 truncate font-medium @xl:order-1 @xl:w-40 @xl:flex-none">{lane.start.step}</span>
        <span className="flex justify-end gap-1 @xl:order-4 @xl:w-32">
          <Pills lane={lane} stuck={stuck} />
        </span>
        <span className="relative h-2 rounded-full bg-raised @xl:order-2 @xl:flex-1">
          <span className={`absolute inset-y-0 rounded-full ${bar}`} style={{ left: `${((start - from) / span) * 100}%`, width: `${Math.max(((end - start) / span) * 100, 1)}%` }} />
        </span>
        <span className="text-right text-muted-foreground @xl:order-3 @xl:w-16">{duration((end - start) / 1000)}</span>
        <span className="text-right @xl:order-5 @xl:w-14">{usd(lane.costUsd)}</span>
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

// limits: minutes per step for the run's target, read on the server.
export function RunTimeline({ run, limits = {} }: { run: string; limits?: Record<string, number> }) {
  const { data, error } = useRunEvents(run);
  const [openId, setOpenId] = useOpenStep();
  if (error)
    return (
      <p role="alert" className="text-destructive">
        {error.message}
      </p>
    );
  if (!data) return <p className="text-muted-foreground">Loading the run…</p>;
  const rows = lanes(data);
  if (rows.length === 0) return <p className="text-muted-foreground">No steps yet.</p>;
  const times = data.map((e) => Date.parse(e.at));
  const from = Math.min(...times);
  const span = Math.max(Math.max(...times) - from, 1);
  const live = rows.find((l) => !l.end);
  const ended = data.find((e) => e.type === "run_end")?.data.outcome as string | undefined;
  const now = new Date();
  const stuck = (l: Lane) => !l.end && isStuck({ step: l.start.step ?? "", startedAt: l.start.at, ended: false }, limits, now);
  const open = rows.find((l) => l.start.id === openId);
  return (
    <>
      <div className={`@container transition-[padding] duration-300 ease-[cubic-bezier(0.2,0,0,1)] ${open ? "xl:pr-[624px]" : ""}`}>
        <div className="mb-8 grid grid-cols-2 border-y @lg:w-fit @lg:min-w-[32rem] @lg:grid-cols-3">
          <Figure label="Now" className="col-span-2 border-b pr-4 @lg:col-span-1 @lg:border-b-0">
            {live ? live.start.step : (ended ?? rows.at(-1)?.outcome ?? "—")}
          </Figure>
          <Figure label="Time" className="pr-4 @lg:border-l @lg:pl-4">
            {duration(span / 1000)}
          </Figure>
          <Figure label="Cost" className="border-l pl-4">
            {usd(rows.reduce((sum, l) => sum + l.costUsd, 0))}
          </Figure>
        </div>
        <SectionHeading className="mb-0">Steps</SectionHeading>
        <ul>
          {rows.map((l) => (
            <LaneRow key={l.start.id} lane={l} from={from} span={span} stuck={stuck(l)} selected={l === open} onSelect={() => setOpenId(l === open ? undefined : l.start.id)} />
          ))}
        </ul>
      </div>
      <Sheet
        open={!!open}
        onClose={() => setOpenId(undefined)}
        title={
          open && (
            <span className="flex flex-wrap items-center gap-2">
              {open.start.step} <Pills lane={open} stuck={stuck(open)} />
            </span>
          )
        }
      >
        {open && <StepDetail key={open.start.id} start={open.start} end={open.end} tools={open.tools} events={open.events} />}
      </Sheet>
    </>
  );
}
