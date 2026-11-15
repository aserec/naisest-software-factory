"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { DIFF_RISK_MAX, STEPS, stepIndex } from "software-factory/run-events";
import Link from "next/link";
import { LayoutGroup, motion } from "motion/react";
import { GitPullRequest, Link2, RefreshCw, Ticket } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { STATE } from "@/lib/state";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import type { BoardRow, FactoryState, Risk } from "@/server/seams";
import { ago, cn, usd, when as at, words, workItemKey } from "@/lib/utils";
import { translator, type T } from "@/lib/i18n";
import { FactoryDown } from "./factory-status";
import { LoadError, SectionHeading } from "./shell";
import { useT } from "./use-preferences";

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
  stateSince?: string; // when the factory set the card's state; none when a person set it on the board
  resolvedCount?: number; // conflict rounds that reached their decision, across all runs
  resolvedAt?: string; // when the newest of them did
}

// The change cannot merge until someone resolves its conflicts: the factory's conflict round, or a person.
export function ConflictsBadge({ conflicts }: { conflicts?: boolean }) {
  const t = useT();
  return conflicts ? <Badge variant="warning" title={t("The change has conflicts with the base branch. The factory starts a round to resolve them.")}>{t("Conflicts")}</Badge> : null;
}

// A ready work item that waits for other open work items. The factory starts it once each one is closed.
export function BlockedByBadge({ blockedBy }: { blockedBy?: string[] }) {
  const t = useT();
  if (!blockedBy?.length) return null;
  const refs = blockedBy.map((u) => `#${u.split("/").pop()}`).join(", ");
  return (
    <Badge variant="warning" title={t(blockedBy.length === 1 ? "Waits until {refs} is closed. The factory starts this work item after that." : "Waits until {refs} are closed. The factory starts this work item after that.", { refs })}>
      <Link2 aria-hidden />
      {t("Waits for {refs}", { refs })}
    </Badge>
  );
}

// Triage risk (Jev 1, on the work item), then merge risk (Jev 2, on the diff), each named so they cannot be confused. High or above the merge limit takes the warning pill; nothing is green,
// so a pill never makes a change look safer than its risk check says.
export function RiskPills({ risk, mergeRisk, mergeRiskMax: max = DIFF_RISK_MAX }: { risk?: Risk; mergeRisk?: number; mergeRiskMax?: number }) {
  const t = useT();
  return (
    <>
      {risk && <Badge variant={risk === "high" ? "warning" : "default"}>{t("Triage risk {risk}", { risk })}</Badge>}
      {mergeRisk !== undefined && (
        <Badge variant={mergeRisk > max ? "warning" : "default"} title={t("Jev 2's risk for the diff. Above {max} never merges without a person.", { max })}>
          {t("Merge risk {risk}/10, limit {max}", { risk: mergeRisk, max })}
        </Badge>
      )}
    </>
  );
}

// Ongoing tab. Left: the states that wait for a person. Right: the ones the factory is working through.
export const WAITING: FactoryState[] = ["needs_approval", "needs_info", "stopped", "blocked"];
const SIDES: [string, FactoryState[]][] = [
  ["Waiting on you", WAITING],
  ["With the factory", ["running", "waiting", "ready"]],
];
// Finished tab: done, and work items a person closed in the tracker before they were done.
const finished = (i: BoardItem) => i.state === "done" || !!i.closed;
// PR problems tab: open work items whose change has conflicts or a failed check, and work items the factory resolved,
// for a day after they finish. The done time is the factory's done label, or the tracker's last update when a person moved the card.
const RESOLVED_DAY = 24 * 60 * 60 * 1000;
const problem = (i: BoardItem) => !!i.conflicts || !!i.checksFailed;
const inProblems = (i: BoardItem, now: number) =>
  finished(i) ? !problem(i) && !!i.resolvedCount && now - Date.parse(i.stateSince ?? i.updatedAt) < RESOLVED_DAY : problem(i) || !!i.resolvedCount;
const TABS = ["ongoing", "problems", "finished"] as const;

// What waits for a person: the left side, plus stuck runs on the right. A finished work item waits for no one.
export const needsYou = (items: BoardItem[]) => items.filter((i) => !finished(i) && (WAITING.includes(i.state) || i.stuck));
export const waitingCount = (items: BoardItem[]) => needsYou(items).length;
// The live counts the Board overview puts on each target's card: the Ongoing and Problems tabs and what waits for a person.
export const boardCounts = (items: BoardItem[], now: number) => ({ ongoing: items.filter((i) => !finished(i)).length, needsYou: waitingCount(items), problems: items.filter((i) => inProblems(i, now)).length });

// The ten steps as one line of segments: reached in ink, the live one in the data hue, a stuck or failed run's step in red.
function Progress({ item: i }: { item: BoardItem }) {
  const t = useT();
  const at = stepIndex(i.reached);
  if (at < 0) return null;
  const now = i.stuck || i.state === "blocked" ? "bg-destructive" : i.stepStartedAt ? "bg-data" : "bg-foreground";
  return (
    <div role="img" aria-label={t("Step {n} of {total}, {step}", { n: at + 1, total: STEPS.length, step: words(STEPS[at]) })} className="flex shrink-0 gap-0.5">
      {STEPS.map((s, n) => (
        <span key={s} className={cn("h-1 w-3 rounded-full", n < at ? "bg-foreground" : n === at ? now : "bg-raised")} />
      ))}
    </div>
  );
}

// "12 of 30 m" against the live step's stuck limit, with a thin bar that turns red once over.
function Clock({ item: i, now }: { item: BoardItem; now: number }) {
  const t = useT();
  if (!i.stepStartedAt || i.stepLimit === undefined) return null;
  const m = Math.max(0, Math.floor((now - Date.parse(i.stepStartedAt)) / 60_000));
  if (!Number.isFinite(m)) return null;
  const over = m > i.stepLimit;
  return (
    <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
      <span className="h-1 w-12 overflow-hidden rounded-full bg-raised">
        <span data-over={over} className={cn("block h-full rounded-full", over ? "bg-destructive" : "bg-data")} style={{ width: `${Math.min(100, (m / i.stepLimit) * 100)}%` }} />
      </span>
      <span className={over ? "text-destructive" : ""}>
        {t("{m} of {limit} m", { m, limit: i.stepLimit })}
      </span>
    </div>
  );
}

function IconLink({ href, label, icon, danger }: { href: string; label: string; icon: React.ReactNode; danger?: boolean }) {
  return (
    <Button asChild variant={danger ? "destructive" : "outline"} size="icon-xs">
      <a href={href} target="_blank" rel="noreferrer" aria-label={label} title={label}>
        {icon}
      </a>
    </Button>
  );
}

const link = "font-medium outline-none after:absolute after:inset-0 after:rounded-lg";

function Row({ item: i, now }: { item: BoardItem; now: number }) {
  const t = useT();
  const when = ago(i.updatedAt);
  const block = i.conflicts ? t("it has conflicts with the base branch") : i.mergeBlock;
  const pr = i.changeUrl && /\/(\d+)\/?$/.exec(i.changeUrl)?.[1]; // GitHub /pull/12, GitLab /merge_requests/12
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
    <motion.li layout="position" layoutId={workItemKey(i)} transition={{ layout: { duration: 0.4 } }} className="relative flex flex-col gap-1 rounded-lg border bg-card p-3 shadow-xs hover:border-foreground/20 hover:bg-active/40 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
      {/* Three fixed lines, so every card has the same height: badges and progress, the title, the state. */}
      <div className="flex items-center gap-2">
        <Badge className="shrink-0 font-mono" title={t("Issue")}>
          <Ticket aria-hidden />#{i.ticket}
        </Badge>
        {pr && (
          <Badge className="shrink-0 font-mono" title={t("PR")}>
            <GitPullRequest aria-hidden />#{pr}
          </Badge>
        )}
        <Progress item={i} />
        {when && (
          <time dateTime={i.updatedAt} title={t("Last activity")} className="shrink-0 text-xs text-muted-foreground">
            {when}
          </time>
        )}
        <Clock item={i} now={now} />
        {/* One line tall: a pill that does not fit wraps to a hidden second line, instead of showing cut. The empty first span lets even a lone pill wrap. */}
        <div className="ml-auto flex h-6 min-w-0 flex-wrap content-start items-center justify-end gap-2 overflow-hidden">
          <span aria-hidden className="-mr-2 h-6 w-0" />
          {i.stuck && <Badge variant="destructive">{t("Stuck")}</Badge>}
          <ConflictsBadge conflicts={i.conflicts} />
          {i.state === "ready" && <BlockedByBadge blockedBy={i.blockedBy} />}
          <RiskPills risk={i.risk} mergeRisk={i.mergeRisk} mergeRiskMax={i.mergeRiskMax} />
        </div>
        {/* No run yet, no cost: the empty span keeps the buttons lined up. */}
        <span className="w-14 shrink-0 text-right">{i.costUsd !== undefined && usd(i.costUsd)}</span>
        {/* relative z-10 lifts the buttons over the card's stretched title link. The PR shows as soon as it exists, red while something stops its merge. */}
        <span className="relative z-10 flex shrink-0 gap-1">
          {i.changeUrl && <IconLink href={i.changeUrl} label={block && i.state !== "done" ? t("Open PR, it cannot merge: {block}", { block }) : t("Open PR")} icon={<GitPullRequest />} danger={!!block && i.state !== "done"} />}
          <IconLink href={i.url} label={t("Open issue")} icon={<Ticket />} />
        </span>
      </div>
      <div className="truncate" title={i.title}>
        {title}
      </div>
      <div className="truncate text-xs text-muted-foreground">
        <span className="font-mono">{i.target}</span>
        {i.step && ` · ${words(i.step)}`}
        {i.round !== undefined && ` · ${t("round {n}", { n: i.round })}`}
        {i.stateSince && (
          <>
            {" · "}
            <time dateTime={i.stateSince}>
              {t("{state} since {time}", { state: t(STATE[i.state]), time: at(i.stateSince) })}
            </time>
          </>
        )}
        {when && ` · ${when}`}
        {i.resolvedAt && (
          <>
            {" · "}
            <time dateTime={i.resolvedAt}>
              {t(i.resolvedCount === 1 ? "Resolved once, last {time}" : "Resolved {n} times, last {time}", { n: i.resolvedCount ?? 0, time: at(i.resolvedAt) })}
            </time>
          </>
        )}
      </div>
    </motion.li>
  );
}

const FINISHED_SHOWN = 10; // Finished columns only grow; the board shows the newest ones.

function Column({ name, items, now, newest }: { name: string; items: BoardItem[]; now: number; newest?: boolean }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const shown = newest && !all ? [...items].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, FINISHED_SHOWN) : items;
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
          {t("Show {n} older", { n: items.length - shown.length })}
        </Button>
      )}
    </section>
  );
}

// target: with fresh, the server reads only that target again (the board of one project).
async function loadBoard(fresh = false, target = "") {
  const r = await api(!fresh ? "/api/board" : target ? `/api/board?fresh=1&target=${encodeURIComponent(target)}` : "/api/board?fresh=1");
  if (!r.ok) throw new Error(`The board answered ${r.status}`);
  return (await r.json()) as BoardItem[];
}

export function useBoard() {
  return useQuery({ queryKey: ["board"], refetchInterval: 15_000, queryFn: () => loadBoard() });
}

// The search and the tab live in the URL (?q=, ?tab=), so a link or a reload keeps them.
function useFilter() {
  const [f, setF] = useState({ q: "", tab: "" });
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    setF({ q: p.get("q") ?? "", tab: p.get("tab") ?? "" });
  }, []);
  const set = (next: Partial<typeof f>) => {
    const v = { ...f, ...next };
    setF(v);
    const url = new URL(window.location.href);
    for (const k of ["q", "tab"] as const) {
      if (v[k]) url.searchParams.set(k, v[k]);
      else url.searchParams.delete(k);
    }
    window.history.replaceState(null, "", url);
  };
  return [f, set] as const;
}

// The search matches the title or "#12"; a target keeps only that target's cards.
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
export function newlyWaiting(prev: BoardItem[], next: BoardItem[], t: T = translator("en")) {
  const before = new Map(prev.map((i) => [workItemKey(i), i]));
  return next.flatMap((i) => {
    const p = before.get(workItemKey(i));
    if ((i.state === "needs_approval" || i.state === "needs_info") && p?.state !== i.state) return [`${t(STATE[i.state])}: ${i.title}`];
    if (i.stuck && !p?.stuck) return [`${t("Stuck")}: ${i.title}`];
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

// One board per target: target keeps only its cards. Without it the board shows every target.
export function Board({ target = "" }: { target?: string }) {
  const t = useT();
  const board = useBoard();
  const { data: all, error } = board;
  const client = useQueryClient();
  // Skips the server's 60 s tracker cache, so a card just moved in the tracker shows now. On one project's board only that
  // project's tracker is read: every board read costs API points (compose.ts CACHE_MS), so reading the others saves nothing.
  const refresh = () => client.fetchQuery({ queryKey: ["board"], queryFn: () => loadBoard(true, target), staleTime: 0 }).catch(() => {});
  const [filter, setFilter] = useFilter();
  const now = useNow();
  const search = useRef<HTMLInputElement>(null);
  useTabTitle(all && waitingCount(all));
  // "/" jumps to the search, unless a person is typing somewhere already.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || el?.closest("input, textarea") || el?.isContentEditable) return;
      e.preventDefault();
      search.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const data = all?.filter((i) => matches(i, { q: filter.q, target }));
  const tab = TABS.find((x) => x === filter.tab) ?? "ongoing";
  const count = (done: boolean) => data?.filter((i) => finished(i) === done).length;
  const problems = data?.filter((i) => inProblems(i, now));
  return (
    <>
      <FactoryDown target={target} />
      {error && <LoadError what="the board" query={board} className="mb-6" />}
      {!error && (
        <div className="mb-6 flex flex-wrap items-center gap-2">
          <input
            ref={search}
            type="search"
            aria-label={t("Search work items")}
            placeholder={t("Search title or #number")}
            value={filter.q}
            onChange={(e) => setFilter({ q: e.target.value })}
            className="h-8 w-64 max-w-full rounded-md border border-input bg-background px-2.5 outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          />
          <Button variant="outline" size="sm" className="ml-auto" disabled={board.isFetching} onClick={refresh}>
            <RefreshCw className={cn(board.isFetching && "motion-safe:animate-spin")} />
            {t("Refresh")}
          </Button>
        </div>
      )}
      {!error && (
        <Tabs value={tab} onValueChange={(v) => setFilter({ tab: v === "ongoing" ? "" : v })} className="mb-6">
          <TabsList>
            <TabsTrigger value="ongoing">
              {t("Ongoing")} <span className="ml-1.5 font-normal text-muted-foreground">{count(false)}</span>
            </TabsTrigger>
            <TabsTrigger value="problems">
              {t("PR problems")} <span className="ml-1.5 font-normal text-muted-foreground">{problems?.length}</span>
            </TabsTrigger>
            <TabsTrigger value="finished">
              {t("Finished")} <span className="ml-1.5 font-normal text-muted-foreground">{count(true)}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      )}
      <div data-scroll>
      {all && data && all.length > 0 && data.length === 0 && <p className="text-muted-foreground">{t("No work item matches the filter.")}</p>}
      {!error && !data && (
        <div aria-busy="true" className="grid items-start gap-x-12 gap-y-8 lg:grid-cols-2">
          <span className="sr-only">{t("Loading the board…")}</span>
          {SIDES.map(([side]) => (
            <div key={side} className="flex flex-col gap-6">
              <h2 className="text-lg leading-7 font-semibold">{t(side)}</h2>
              {[2, 1].map((cards, n) => (
                <div key={n} className="motion-safe:animate-pulse">
                  <div className="mb-3 border-b pb-2">
                    <div className="h-5 w-28 rounded bg-raised" />
                  </div>
                  <div className="flex flex-col gap-2">
                    {Array.from({ length: cards }, (_, c) => (
                      <div key={c} className="h-[94px] rounded-lg border bg-raised/60" />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {data && (all?.length === 0 || data.length > 0) && tab === "finished" && (
        <div className="grid items-start gap-x-12 gap-y-8 lg:grid-cols-2">
          <Column name={t(STATE.done)} items={data.filter((i) => i.state === "done")} now={now} newest />
          <Column name={t("Closed")} items={data.filter((i) => i.closed && i.state !== "done")} now={now} newest />
        </div>
      )}
      {problems && (all?.length === 0 || data!.length > 0) && tab === "problems" && (
        <div className="grid items-start gap-x-12 gap-y-8 lg:grid-cols-3">
          {/* A live step is the round at work. A run paused for a person is not: its change waits for the next round or a person. */}
          <Column name={t("Waiting")} items={problems.filter((i) => problem(i) && !i.stepStartedAt)} now={now} />
          <Column name={t("Being resolved")} items={problems.filter((i) => problem(i) && i.stepStartedAt)} now={now} />
          <Column name={t("Resolved")} items={problems.filter((i) => !problem(i))} now={now} newest />
        </div>
      )}
      {data && (all?.length === 0 || data.length > 0) && tab === "ongoing" && (
        <LayoutGroup>
        <div className="grid items-start gap-x-12 gap-y-8 lg:grid-cols-2">
          {SIDES.map(([side, states]) => {
            const of = (s: FactoryState) => data.filter((i) => i.state === s && !finished(i));
            return (
              <div key={side} className="flex flex-col gap-6">
                <h2 className="text-lg leading-7 font-semibold">{t(side)}</h2>
                {/* Every state keeps its section, an empty one with its 0, so the columns never move. */}
                {states.map((s) => (
                  <Column key={s} name={t(STATE[s])} items={of(s)} now={now} />
                ))}
              </div>
            );
          })}
        </div>
        </LayoutGroup>
      )}
      </div>
    </>
  );
}
