"use client";

import { useQuery } from "@tanstack/react-query";
import { DIFF_RISK_MAX } from "software-factory/run-events";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { ago, usd } from "@/lib/utils";
import { SectionHeading } from "./shell";

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
  risk?: string; // triage risk, from the factory_risk_* label
  step?: string; // the live step of an open run
  round?: number; // the highest code-review round
  mergeRisk?: number; // Jev 2's diff_risk, 2 to 10
  mrUrl?: string;
}

// Triage risk, then Jev 2's merge risk. High or above the merge limit takes the warning pill; nothing is green,
// so a pill never makes a change look safer than its risk check says.
export function RiskPills({ risk, mergeRisk }: { risk?: string; mergeRisk?: number }) {
  return (
    <>
      {risk && <Badge variant={risk === "high" ? "warning" : "default"}>{risk[0].toUpperCase() + risk.slice(1)} risk</Badge>}
      {mergeRisk !== undefined && (
        <Badge variant={mergeRisk > DIFF_RISK_MAX ? "warning" : "default"} title={`Jev 2's diff risk. Above ${DIFF_RISK_MAX} never merges without a person.`}>
          Merge risk {mergeRisk}/10
        </Badge>
      )}
    </>
  );
}

// The board's name for each label.
export const STATE: Record<string, string> = {
  factory_needs_approval: "Needs approval",
  factory_needs_info: "Needs info",
  factory_stopped: "Stopped",
  factory_blocked: "Blocked",
  factory_running: "Running",
  factory_waiting: "Waiting",
  factory_ready: "Ready",
  factory_done: "Done",
};

// Left: the labels that wait for a person. Right: the ones the factory is working through.
const SIDES: [string, string[]][] = [
  ["Waiting on you", ["factory_needs_approval", "factory_needs_info", "factory_stopped", "factory_blocked"]],
  ["With the factory", ["factory_running", "factory_waiting", "factory_ready", "factory_done"]],
];

const link = "font-medium outline-none after:absolute after:inset-0 after:rounded-lg";

function Row({ item: i }: { item: BoardItem }) {
  const when = ago(i.updatedAt);
  const title = i.run ? (
    <Link href={`/runs/${encodeURIComponent(i.run)}`} className={link}>
      {i.title}
    </Link>
  ) : (
    <a href={i.url} className={link}>
      {i.title}
    </a>
  );
  // The whole card is the link, so the focus ring goes on the card.
  return (
    <li className="relative flex flex-wrap items-start justify-between gap-x-4 gap-y-2 rounded-lg border bg-card p-3 shadow-xs hover:border-foreground/20 hover:bg-active/40 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
      <div className="min-w-0 flex-1 basis-48">
        {title}
        <div className="mt-0.5 text-xs text-muted-foreground">
          <span className="font-mono">
            {i.target} #{i.ticket}
          </span>
          {i.step && ` · ${i.step}`}
          {i.round !== undefined && ` · round ${i.round}`}
          {when && ` · ${when}`}
        </div>
      </div>
      <div className="ml-auto flex flex-none items-center gap-2 pt-px">
        {i.stuck && <Badge variant="destructive">Stuck</Badge>}
        <RiskPills risk={i.risk} mergeRisk={i.mergeRisk} />
        <span className={`w-14 text-right ${i.costUsd === undefined ? "text-muted-foreground" : ""}`}>{i.costUsd === undefined ? "—" : usd(i.costUsd)}</span>
      </div>
    </li>
  );
}

const DONE_SHOWN = 10; // Done only grows; the board shows the newest ones.

function Column({ state, items }: { state: string; items: BoardItem[] }) {
  const name = STATE[state] ?? state;
  const shown = state === "factory_done" ? [...items].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, DONE_SHOWN) : items;
  return (
    <section>
      <SectionHeading as="h3">
        {name} <span className="font-normal text-muted-foreground">{items.length}</span>
      </SectionHeading>
      <ul className="flex flex-col gap-2">
        {shown.map((i) => (
          <Row key={`${i.target}/${i.ticket}`} item={i} />
        ))}
      </ul>
      {shown.length < items.length && <p className="mt-3 text-muted-foreground">And {items.length - shown.length} older.</p>}
    </section>
  );
}

// "Stopped and Blocked are empty." One quiet line for every empty label on a side, instead of a heading each.
export function emptyLine(states: string[]) {
  const names = states.map((s) => STATE[s] ?? s);
  if (names.length === 0) return undefined;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${list} ${names.length === 1 ? "is" : "are"} empty.`;
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
      {!data && !error && <p className="text-muted-foreground">Loading the board…</p>}
      {data && (
        <div className="grid items-start gap-x-12 gap-y-8 lg:grid-cols-2">
          {SIDES.map(([side, states]) => {
            const of = (s: string) => data.filter((i) => i.state === s);
            const empty = emptyLine(states.filter((s) => of(s).length === 0));
            return (
              <div key={side} className="flex flex-col gap-6">
                <h2 className="text-lg leading-7 font-semibold">{side}</h2>
                {states
                  .filter((s) => of(s).length > 0)
                  .map((s) => (
                    <Column key={s} state={s} items={of(s)} />
                  ))}
                {empty && <p className="text-muted-foreground">{empty}</p>}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

export function BoardFinding() {
  const { data } = useBoard();
  return data ? finding(data) : null;
}
