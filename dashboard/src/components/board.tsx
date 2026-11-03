"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { ago, usd } from "@/lib/utils";

// One column per state label. Keep in step with STATES in server/gitlab.ts.
export const STATES = ["ready", "running", "waiting", "needs_info", "needs_approval", "done", "stopped", "blocked"].map((s) => `factory_${s}`);

export interface BoardItem {
  target: string;
  ticket: string;
  title: string;
  state: string;
  url: string;
  updatedAt: string;
  run?: string;
  costUsd?: number;
  stuck: boolean;
}

// The board's name for each label, and what an empty one says.
const STATE: Record<string, [name: string, empty: string]> = {
  factory_needs_approval: ["Needs approval", "Nothing to approve."],
  factory_needs_info: ["Needs info", "No open questions."],
  factory_stopped: ["Stopped", "No stopped runs."],
  factory_blocked: ["Blocked", "Nothing is blocked."],
  factory_running: ["Running", "No run is going."],
  factory_waiting: ["Waiting", "Nothing is waiting."],
  factory_ready: ["Ready", "No ticket is queued."],
  factory_done: ["Done", "Nothing finished yet."],
};

// Left: the labels that wait for a person. Right: the ones the factory is working through.
const SIDES: [string, string[]][] = [
  ["Waiting on you", ["factory_needs_approval", "factory_needs_info", "factory_stopped", "factory_blocked"]],
  ["With the factory", ["factory_running", "factory_waiting", "factory_ready", "factory_done"]],
];

function Row({ item: i }: { item: BoardItem }) {
  const when = ago(i.updatedAt);
  const title = i.run ? (
    <Link href={`/runs/${encodeURIComponent(i.run)}`} className="font-medium after:absolute after:inset-0 after:rounded-lg">
      {i.title}
    </Link>
  ) : (
    <a href={i.url} className="font-medium after:absolute after:inset-0 after:rounded-lg">
      {i.title}
    </a>
  );
  return (
    <li className="relative flex items-start justify-between gap-4 rounded-lg border bg-card p-3 shadow-xs hover:border-foreground/20 hover:bg-active/40">
      <div className="min-w-0">
        {title}
        <div className="mt-0.5 text-xs text-muted-foreground">
          <span className="font-mono">
            {i.target} #{i.ticket}
          </span>
          {when && ` · ${when}`}
        </div>
      </div>
      <div className="flex flex-none items-center gap-3 pt-px">
        {i.stuck && <Badge variant="destructive">Stuck</Badge>}
        <span className={`w-14 text-right ${i.costUsd === undefined ? "text-muted-foreground" : ""}`}>{i.costUsd === undefined ? "—" : usd(i.costUsd)}</span>
      </div>
    </li>
  );
}

function Column({ state, items }: { state: string; items?: BoardItem[] }) {
  const [name, empty] = STATE[state] ?? [state, "None."];
  return (
    <section>
      <h2 className="flex items-baseline gap-2 border-b pb-2 text-base font-semibold">
        {name} <span className="font-normal text-muted-foreground">{items ? items.length : "—"}</span>
      </h2>
      {items && (items.length ? <ul className="flex flex-col gap-2 pt-3">{items.map((i) => <Row key={`${i.target}/${i.ticket}`} item={i} />)}</ul> : <p className="py-3 text-muted-foreground">{empty}</p>)}
    </section>
  );
}

// "1 to approve, 2 need an answer, 1 run stuck." The finding that goes under the title.
export function finding(items: BoardItem[]) {
  const n = (s: string) => items.filter((i) => i.state === `factory_${s}`).length;
  const stuck = items.filter((i) => i.stuck).length;
  const parts = [
    n("needs_approval") && `${n("needs_approval")} to approve`,
    n("needs_info") && `${n("needs_info")} ${n("needs_info") === 1 ? "needs" : "need"} an answer`,
    n("stopped") && `${n("stopped")} stopped`,
    stuck && `${stuck} ${stuck === 1 ? "run" : "runs"} stuck`,
  ].filter(Boolean);
  return parts.length ? `${parts.join(", ")}.` : "Nothing waits for you.";
}

export function useBoard() {
  return useQuery({
    queryKey: ["board"],
    refetchInterval: 15_000,
    queryFn: async () => {
      const r = await api("/api/board");
      if (!r.ok) throw new Error(`The board answered ${r.status}`);
      return (await r.json()) as BoardItem[];
    },
  });
}

export function Board() {
  const { data, error } = useBoard();
  return (
    <>
      {error && (
        <p role="alert" className="mb-6 text-destructive">
          {error.message}
        </p>
      )}
      <div className="grid items-start gap-x-12 gap-y-10 lg:grid-cols-2">
        {SIDES.map(([side, states]) => (
          <div key={side} className="flex flex-col gap-8">
            <p className="-mb-4 text-xs text-muted-foreground">{side}</p>
            {states.map((s) => (
              <Column key={s} state={s} items={data?.filter((i) => i.state === s)} />
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

export function BoardFinding() {
  const { data } = useBoard();
  return data ? finding(data) : null;
}
