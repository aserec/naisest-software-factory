"use client";

import Link from "next/link";
import type { Insights } from "@/server/insights"; // types and Intl only, safe in the browser
import { pct } from "@/server/insights";
import type { InsightsPayload } from "@/server/insights-load";
import { duration, usd } from "@/lib/utils";
import { boardCounts, useBoard, type BoardItem } from "./board";
import { InsightsPanel } from "./insights-panel";
import { LoadError, SectionHeading } from "./shell";
import { useT } from "./use-preferences";

// One card per target: the board as it is now, then its runs in the range; a target with no run still gets its card.
// board: undefined while the board loads, so its counts read "—".
export function TargetSummaries({ data, targets, board, now = Date.now() }: { data: Insights; targets: string[]; board?: BoardItem[]; now?: number }) {
  const t = useT();
  if (!targets.length) return <p className="text-muted-foreground">{t("No target is set up.")}</p>;
  return (
    <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {targets.map((name) => {
        const rows = data.list.filter((r) => r.target === name);
        const n = (k: string) => rows.filter((r) => r.kind === k).length;
        const cost = rows.reduce((a, r) => a + r.costUsd, 0);
        const secs = rows.flatMap((r) => (r.secs === undefined ? [] : [r.secs]));
        const live = board && boardCounts(board.filter((i) => i.target === name), now);
        const counts: [string, number | undefined][] = [
          ["Ongoing", live?.ongoing],
          ["Needs you", live?.needsYou],
          ["Problems", live?.problems],
        ];
        const figures: [string, React.ReactNode][] = [
          ["Merged alone", n("auto")],
          ["Sent to a person", n("person")],
          ["Ended without a change", n("stopped")],
          ["Running", n("open")],
          ["Cost", usd(cost)],
          ["Time per run", secs.length ? duration(pct(secs, 50)) : "—"],
        ];
        return (
          <li key={name} className="relative rounded-xl border p-4 hover:bg-raised">
            <SectionHeading className="justify-between">
              {/* The link covers the card, so the whole card opens the target's board. */}
              <Link href={`/boards/${encodeURIComponent(name)}`} className="truncate font-mono text-sm font-semibold outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-ring">
                {name}
              </Link>
              <span className="shrink-0 text-xs text-muted-foreground">{t("{n} runs", { n: rows.length })}</span>
            </SectionHeading>
            <dl className="mb-3 grid grid-cols-3 gap-x-4 text-sm">
              {counts.map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="truncate text-xs text-muted-foreground">{t(label)}</dt>
                  <dd className={value && label !== "Ongoing" ? "font-semibold" : undefined}>{value ?? "—"}</dd>
                </div>
              ))}
            </dl>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              {figures.map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="truncate text-xs text-muted-foreground">{t(label)}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </li>
        );
      })}
    </ul>
  );
}

export function BoardsOverview({ initial, hasZone, targets }: { initial: InsightsPayload; hasZone: boolean; targets: string[] }) {
  const t = useT();
  const board = useBoard();
  return (
    <>
      <InsightsPanel title={t("Board")} initial={initial} hasZone={hasZone} view={(d) => <TargetSummaries data={d} targets={targets} board={board.data} now={board.dataUpdatedAt || undefined} />} />
      {board.error && <LoadError what="the board" query={board} className="mt-6" />}
    </>
  );
}
