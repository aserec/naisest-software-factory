"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { DIFF_RISK_MAX, STEPS, stepIndex } from "software-factory/run-events";
import Link from "next/link";
import { LayoutGroup, motion } from "motion/react";
import { CircleDot, GitPullRequest, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { STATE } from "@/lib/state";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { BoardRow, FactoryState, Risk } from "@/server/seams";
import { ago, cn, usd, words, workItemKey } from "@/lib/utils";
import { LoadError, SectionHeading } from "./shell";

export interface BoardItem extends BoardRow {
  run?: string;
  costUsd?: number;
  stuck: boolean;
  step?: string; // the live step of an open run
  reached?: string; // the last step any run reached, ended or not
  stepStartedAt?: string; // when the step the factory works on now began; none between steps or while paused
  stepLimit?: number; // that step's stuck limit in minutes, when it has one
  round?: number; // the highest code-review round
  mergeRisk?: number; // Jev 2's diff_risk, 2 to 10
  mergeRiskMax?: number; // the target's limit; older runs did not send it
  changeUrl?: string;
  conflicts?: boolean; // the change has conflicts with the base branch
}

// The change cannot merge until someone resolves its conflicts: the factory's conflict round, or a person.
export function ConflictsBadge({ conflicts }: { conflicts?: boolean }) {
  return conflicts ? <Badge variant="warning" title="The change has conflicts with the base branch. The factory starts a round to resolve them.">Conflicts</Badge> : null;
}

// Triage risk (Jev 1, on the work item), then merge risk (Jev 2, on the diff), each named so they cannot be confused. High or above the merge limit takes the warning pill; nothing is green,
// so a pill never makes a change look safer than its risk check says.
export function RiskPills({ risk, mergeRisk, mergeRiskMax: max = DIFF_RISK_MAX }: { risk?: Risk; mergeRisk?: number; mergeRiskMax?: number }) {
  return (
    <>
      {risk && <Badge variant={risk === "high" ? "warning" : "default"}>Triage risk {risk}</Badge>}
      {mergeRisk !== undefined && (
        <Badge variant={mergeRisk > max ? "warning" : "default"} title={`Jev 2's risk for the diff. Above ${max} never merges without a person.`}>
          Merge risk {mergeRisk}/10, limit {max}
        </Badge>
      )}
    </>
  );
}

// Left: the states that wait for a person. Right: the ones the factory is working through.
const WAITING: FactoryState[] = ["needs_approval", "needs_info", "stopped", "blocked"];
const SIDES: [string, FactoryState[]][] = [
  ["Waiting on you", WAITING],
  ["With the factory", ["running", "waiting", "ready", "done"]],
];

// What waits for a person: the left side, plus stuck runs on the right.
export const needsYou = (items: BoardItem[]) => items.filter((i) => WAITING.includes(i.state) || i.stuck);
export const waitingCount = (items: BoardItem[]) => needsYou(items).length;

// The ten steps as one line of segments: reached in ink, the live one in the data hue, a stuck or failed run's step in red.
function Progress({ item: i }: { item: BoardItem }) {
  const at = stepIndex(i.reached);
  if (at < 0) return null;
  const now = i.stuck || i.state === "blocked" ? "bg-destructive" : i.stepStartedAt ? "bg-data" : "bg-foreground";
  return (
    <div role="img" aria-label={`Step ${at + 1} of ${STEPS.length}, ${words(STEPS[at])}`} className="mt-2 flex gap-0.5">
      {STEPS.map((s, n) => (
        <span key={s} className={cn("h-1 w-3 rounded-full", n < at ? "bg-foreground" : n === at ? now : "bg-raised")} />
      ))}
    </div>
  );
}

// "12 of 30 m" against the live step's stuck limit, with a thin bar that turns red once over.
function Clock({ item: i, now }: { item: BoardItem; now: number }) {
  if (!i.stepStartedAt || i.stepLimit === undefined) return null;
  const m = Math.max(0, Math.floor((now - Date.parse(i.stepStartedAt)) / 60_000));
  if (!Number.isFinite(m)) return null;
  const over = m > i.stepLimit;
  return (
    <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
      <span className="h-1 w-12 overflow-hidden rounded-full bg-raised">
        <span data-over={over} className={cn("block h-full rounded-full", over ? "bg-destructive" : "bg-data")} style={{ width: `${Math.min(100, (m / i.stepLimit) * 100)}%` }} />
      </span>
      <span className={over ? "text-destructive" : ""}>
        {m} of {i.stepLimit} m
      </span>
    </div>
  );
}

function IconLink({ href, label, icon }: { href: string; label: string; icon: React.ReactNode }) {
  return (
    <Button asChild variant="ghost" size="icon-xs">
      <a href={href} target="_blank" rel="noreferrer" aria-label={label} title={label}>
        {icon}
      </a>
    </Button>
  );
}

const link = "font-medium outline-none after:absolute after:inset-0 after:rounded-lg";

function Row({ item: i, now }: { item: BoardItem; now: number }) {
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
  // layoutId: a card that changes state slides from its old section to its new one. MotionConfig in providers.tsx honours reduced motion.
  return (
    <motion.li layout="position" layoutId={workItemKey(i)} transition={{ layout: { duration: 0.4 } }} className="relative flex flex-wrap items-start justify-between gap-x-4 gap-y-2 rounded-lg border bg-card p-3 shadow-xs hover:border-foreground/20 hover:bg-active/40 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
      <div className="min-w-0 flex-1 basis-48">
        {title}
        <div className="mt-0.5 text-xs text-muted-foreground">
          <span className="font-mono">
            {i.target} #{i.ticket}
          </span>
          {i.step && ` · ${words(i.step)}`}
          {i.round !== undefined && ` · round ${i.round}`}
          {when && ` · ${when}`}
        </div>
        <Progress item={i} />
        <Clock item={i} now={now} />
      </div>
      <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2 pt-px">
        {i.stuck && <Badge variant="destructive">Stuck</Badge>}
        <ConflictsBadge conflicts={i.conflicts} />
        <RiskPills risk={i.risk} mergeRisk={i.mergeRisk} mergeRiskMax={i.mergeRiskMax} />
        <span className={`w-14 text-right ${i.costUsd === undefined ? "text-muted-foreground" : ""}`}>{i.costUsd === undefined ? "—" : usd(i.costUsd)}</span>
        {/* relative z-10 lifts the buttons over the card's stretched title link. The PR shows once the work waits for a person or is done. */}
        <span className="relative z-10 flex gap-1">
          {i.changeUrl && (i.state === "done" || WAITING.includes(i.state)) && <IconLink href={i.changeUrl} label="Open PR" icon={<GitPullRequest />} />}
          <IconLink href={i.url} label="Open issue" icon={<CircleDot />} />
        </span>
      </div>
    </motion.li>
  );
}

const DONE_SHOWN = 10; // Done only grows; the board shows the newest ones.

function Column({ state, items, now }: { state: FactoryState; items: BoardItem[]; now: number }) {
  const name = STATE[state];
  const [all, setAll] = useState(false);
  const shown = state === "done" && !all ? [...items].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, DONE_SHOWN) : items;
  return (
    <section>
      <SectionHeading as="h3">
        {name} <span className="font-normal text-muted-foreground">{items.length}</span>
      </SectionHeading>
      <ul className="flex flex-col gap-2">
        {shown.map((i) => (
          <Row key={workItemKey(i)} item={i} now={now} />
        ))}
      </ul>
      {shown.length < items.length && (
        <Button variant="ghost" size="sm" className="mt-2 text-muted-foreground" onClick={() => setAll(true)}>
          Show {items.length - shown.length} older
        </Button>
      )}
    </section>
  );
}

async function loadBoard(fresh = false) {
  const r = await api(fresh ? "/api/board?fresh=1" : "/api/board");
  if (!r.ok) throw new Error(`The board answered ${r.status}`);
  return (await r.json()) as BoardItem[];
}

export function useBoard() {
  return useQuery({ queryKey: ["board"], refetchInterval: 15_000, queryFn: () => loadBoard() });
}

// The filter lives in the URL (?q=, ?target=), so a link or a reload keeps it.
function useFilter() {
  const [f, setF] = useState({ q: "", target: "" });
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    setF({ q: p.get("q") ?? "", target: p.get("target") ?? "" });
  }, []);
  const set = (next: Partial<typeof f>) => {
    const v = { ...f, ...next };
    setF(v);
    const url = new URL(window.location.href);
    for (const k of ["q", "target"] as const) {
      if (v[k]) url.searchParams.set(k, v[k]);
      else url.searchParams.delete(k);
    }
    window.history.replaceState(null, "", url);
  };
  return [f, set] as const;
}

// The search matches the title or "#12"; a target chip keeps only that target.
export function matches(i: BoardItem, { q, target }: { q: string; target: string }) {
  const s = q.trim().toLowerCase();
  return (!target || i.target === target) && (!s || i.title.toLowerCase().includes(s) || `#${i.ticket}`.includes(s));
}

// "(2) Factory" in the tab while things wait for a person; layout.tsx sets plain "Factory".
function useTabTitle(n: number | undefined) {
  useEffect(() => {
    if (n !== undefined) document.title = n ? `(${n}) Factory` : "Factory";
  }, [n]);
  useEffect(() => () => void (document.title = "Factory"), []);
}

// What turned to need a person between two board loads: entered needs approval or needs info, or a run turned stuck.
export function newlyWaiting(prev: BoardItem[], next: BoardItem[]) {
  const before = new Map(prev.map((i) => [workItemKey(i), i]));
  return next.flatMap((i) => {
    const p = before.get(workItemKey(i));
    if ((i.state === "needs_approval" || i.state === "needs_info") && p?.state !== i.state) return [`${STATE[i.state]}: ${i.title}`];
    if (i.stuck && !p?.stuck) return [`Stuck: ${i.title}`];
    return [];
  });
}

// The clock the card times count against; minutes are enough.
function useNow() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function Board() {
  const board = useBoard();
  const { data: all, error } = board;
  const client = useQueryClient();
  // Skips the server's 15 s tracker cache, so a card just moved in the tracker shows now.
  const refresh = () => client.fetchQuery({ queryKey: ["board"], queryFn: () => loadBoard(true), staleTime: 0 }).catch(() => {});
  const [filter, setFilter] = useFilter();
  const now = useNow();
  const search = useRef<HTMLInputElement>(null);
  useTabTitle(all && waitingCount(all));
  // "/" jumps to the search, unless a person is typing somewhere already.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || t?.closest("input, textarea") || t?.isContentEditable) return;
      e.preventDefault();
      search.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const targets = [...new Set(all?.map((i) => i.target))].sort();
  const data = all?.filter((i) => matches(i, filter));
  return (
    <>
      {error && <LoadError what="the board" query={board} className="mb-6" />}
      {!error && (
        <div className="mb-6 flex flex-wrap items-center gap-2">
          <input
            ref={search}
            type="search"
            aria-label="Search work items"
            placeholder="Search title or #number"
            value={filter.q}
            onChange={(e) => setFilter({ q: e.target.value })}
            className="h-8 w-64 max-w-full rounded-md border border-input bg-background px-2.5 outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          />
          {targets.length > 1 &&
            targets.map((t) => (
              <Button key={t} variant={filter.target === t ? "secondary" : "outline"} size="sm" aria-pressed={filter.target === t} className="font-mono text-xs" onClick={() => setFilter({ target: filter.target === t ? "" : t })}>
                {t}
              </Button>
            ))}
          <Button variant="outline" size="sm" className="ml-auto" disabled={board.isFetching} onClick={refresh}>
            <RefreshCw className={cn(board.isFetching && "motion-safe:animate-spin")} />
            Refresh
          </Button>
        </div>
      )}
      {all && data && all.length > 0 && data.length === 0 && <p className="text-muted-foreground">No work item matches the filter.</p>}
      {!error && !data && (
        <div aria-busy="true" className="grid items-start gap-x-12 gap-y-8 lg:grid-cols-2">
          <span className="sr-only">Loading the board…</span>
          {SIDES.map(([side]) => (
            <div key={side} className="flex flex-col gap-6">
              <h2 className="text-lg leading-7 font-semibold">{side}</h2>
              {[2, 1].map((cards, n) => (
                <div key={n} className="motion-safe:animate-pulse">
                  <div className="mb-3 border-b pb-2">
                    <div className="h-5 w-28 rounded bg-raised" />
                  </div>
                  <div className="flex flex-col gap-2">
                    {Array.from({ length: cards }, (_, c) => (
                      <div key={c} className="h-[74px] rounded-lg border bg-raised/60" />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {data && (all?.length === 0 || data.length > 0) && (
        <LayoutGroup>
        <div className="grid items-start gap-x-12 gap-y-8 lg:grid-cols-2">
          {SIDES.map(([side, states]) => {
            const of = (s: FactoryState) => data.filter((i) => i.state === s);
            return (
              <div key={side} className="flex flex-col gap-6">
                <h2 className="text-lg leading-7 font-semibold">{side}</h2>
                {/* Every state keeps its section, an empty one with its 0, so the columns never move. */}
                {states.map((s) => (
                  <Column key={s} state={s} items={of(s)} now={now} />
                ))}
              </div>
            );
          })}
        </div>
        </LayoutGroup>
      )}
    </>
  );
}
