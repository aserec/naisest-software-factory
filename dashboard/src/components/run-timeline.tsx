"use client";

import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { RunEvent } from "software-factory/run-events";
import { Badge } from "@/components/ui/badge";
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

function LaneRow({ lane, from, span, limits }: { lane: Lane; from: number; span: number; limits: Record<string, number> }) {
  const [open, setOpen] = useState(false);
  const start = Date.parse(lane.start.at);
  const end = lane.end ? Date.parse(lane.end.at) : from + span;
  const secs = Math.round((end - start) / 1000);
  const stuck = !lane.end && isStuck({ step: lane.start.step ?? "", startedAt: lane.start.at, ended: false }, limits, new Date());
  return (
    <li className="rounded border p-2">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 text-left">
        <span className="w-40 font-medium">{lane.start.step}</span>
        <span className="relative h-3 flex-1 rounded bg-muted">
          <span className="absolute h-3 rounded bg-primary" style={{ left: `${((start - from) / span) * 100}%`, width: `${Math.max(((end - start) / span) * 100, 1)}%` }} />
        </span>
        <span className="w-16 text-right text-sm">{secs} s</span>
        <Badge variant={lane.outcome === "error" ? "destructive" : "secondary"}>{lane.outcome ?? "running"}</Badge>
        {stuck && <Badge variant="destructive">Stuck</Badge>}
        <span className="w-16 text-right text-sm">${lane.costUsd.toFixed(2)}</span>
      </button>
      {open && (
        <div className="mt-2 pl-4">
          <ul>
            {lane.tools.map((t) => (
              <li key={t.id}>
                <details>
                  <summary>
                    {t.data.name as string} <span className="text-xs text-muted-foreground">{t.data.ms as number} ms{t.data.ok ? "" : ", failed"}</span>
                  </summary>
                  <pre className="whitespace-pre-wrap text-xs">{t.data.input as string}</pre>
                  <pre className="whitespace-pre-wrap text-xs">{t.data.result as string}</pre>
                </details>
              </li>
            ))}
          </ul>
          {lane.tools.length === 0 && <p className="text-sm">No tool calls.</p>}
          <div className="mt-2">
            <StepDetail start={lane.start} events={lane.events} />
          </div>
        </div>
      )}
    </li>
  );
}

// limits: minutes per step for the run's target, read on the server.
export function RunTimeline({ run, limits = {} }: { run: string; limits?: Record<string, number> }) {
  const { data, error } = useRunEvents(run);
  if (error) return <p role="alert">{error.message}</p>;
  if (!data) return <p>Loading...</p>;
  const rows = lanes(data);
  if (rows.length === 0) return <p>No steps yet.</p>;
  const times = data.map((e) => Date.parse(e.at));
  const from = Math.min(...times);
  const span = Math.max(Math.max(...times) - from, 1);
  return (
    <ul className="space-y-2">
      {rows.map((l) => (
        <LaneRow key={l.start.id} lane={l} from={from} span={span} limits={limits} />
      ))}
    </ul>
  );
}
