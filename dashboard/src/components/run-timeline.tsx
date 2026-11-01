"use client";

import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { RunEvent } from "software-factory/run-events";
import { Badge } from "@/components/ui/badge";
import { duration, usd } from "@/lib/utils";
import { StepDetail } from "./step-detail";
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

function LaneRow({ lane, from, span, limits }: { lane: Lane; from: number; span: number; limits: Record<string, number> }) {
  const [open, setOpen] = useState(false);
  const start = Date.parse(lane.start.at);
  const end = lane.end ? Date.parse(lane.end.at) : from + span;
  const stuck = !lane.end && isStuck({ step: lane.start.step ?? "", startedAt: lane.start.at, ended: false }, limits, new Date());
  // The production line: ended steps in ink, the live one in the data hue, a failed or stuck one in red.
  const bar = lane.outcome === "error" || stuck ? "bg-destructive" : lane.end ? "bg-foreground/70" : "bg-data";
  return (
    <li className="border-b border-rule last:border-0">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 py-3 text-left hover:bg-raised/60 active:scale-[0.995] sm:flex-nowrap">
        <span className="min-w-0 flex-1 truncate font-medium sm:w-40 sm:flex-none">{lane.start.step}</span>
        <span className="relative order-last h-2 w-full rounded-full bg-raised sm:order-none sm:w-auto sm:flex-1">
          <span className={`absolute inset-y-0 rounded-full ${bar}`} style={{ left: `${((start - from) / span) * 100}%`, width: `${Math.max(((end - start) / span) * 100, 1)}%` }} />
        </span>
        <span className="w-16 text-right text-muted-foreground">{duration((end - start) / 1000)}</span>
        <span className="flex w-36 justify-end gap-1">
          {stuck && <Badge variant="destructive">Stuck</Badge>}
          <Badge variant={PILL[lane.outcome ?? ""] ?? "secondary"}>{lane.outcome ?? "running"}</Badge>
        </span>
        <span className="w-14 text-right">{usd(lane.costUsd)}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-3 pb-4 sm:pl-44">
          {lane.tools.length === 0 ? (
            <p className="text-muted-foreground">No tool calls.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {lane.tools.map((t) => (
                <li key={t.id}>
                  <details>
                    <summary className="w-fit hover:underline">
                      {t.data.name as string}{" "}
                      <span className="text-xs text-muted-foreground">
                        {t.data.ms as number} ms{t.data.ok ? "" : ", failed"}
                      </span>
                    </summary>
                    <pre className="mt-1 rounded-md bg-raised p-3 font-mono text-xs whitespace-pre-wrap">{t.data.input as string}</pre>
                    <pre className="mt-1 rounded-md bg-raised p-3 font-mono text-xs whitespace-pre-wrap">{t.data.result as string}</pre>
                  </details>
                </li>
              ))}
            </ul>
          )}
          <div>
            <StepDetail start={lane.start} events={lane.events} />
          </div>
        </div>
      )}
    </li>
  );
}

const Figure = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="px-5 py-4 first:pl-0">
    <div className="text-muted-foreground">{label}</div>
    <div className="mt-1 text-2xl leading-8">{children}</div>
  </div>
);

// limits: minutes per step for the run's target, read on the server.
export function RunTimeline({ run, limits = {} }: { run: string; limits?: Record<string, number> }) {
  const { data, error } = useRunEvents(run);
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
  return (
    <>
      <div className="mb-10 grid grid-cols-3 divide-x border-y sm:w-fit sm:min-w-[32rem]">
        <Figure label="Now">{live ? live.start.step : (ended ?? rows.at(-1)?.outcome ?? "—")}</Figure>
        <Figure label="Time">{duration(span / 1000)}</Figure>
        <Figure label="Cost">{usd(rows.reduce((sum, l) => sum + l.costUsd, 0))}</Figure>
      </div>
      <h2 className="mb-1 text-base font-semibold">Steps</h2>
      <ul className="border-t">
        {rows.map((l) => (
          <LaneRow key={l.start.id} lane={l} from={from} span={span} limits={limits} />
        ))}
      </ul>
    </>
  );
}
