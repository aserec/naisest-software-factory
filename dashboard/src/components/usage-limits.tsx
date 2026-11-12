"use client";

import { useQuery } from "@tanstack/react-query";
import type { UsageLimits as Limits } from "software-factory/run-events";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { ago, cn } from "@/lib/utils";
import { useT } from "./use-preferences";

type Window = Limits["fiveHour"];

// A window whose reset time has passed starts again at 0.
const usedNow = (w: Window, now: number) => (Date.parse(w.resetsAt) <= now ? 0 : Math.round(w.used * 100));
const tone = (pct: number) =>
  pct >= 90 ? "border-pill-negative-ink/20 bg-pill-negative text-pill-negative-ink" : pct >= 70 ? "border-pill-warning-ink/20 bg-pill-warning text-pill-warning-ink" : "border-pill-positive-ink/20 bg-pill-positive text-pill-positive-ink";
const pill = "flex h-6 items-center gap-1 rounded-full border px-2 font-medium";
const resets = (w: Window) => new Date(w.resetsAt).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });

// The Claude plan's usage beside the bell: the 5-hour window and the 7-day window, as the newest factory run saw them.
export function UsageLimits() {
  const t = useT();
  const { data } = useQuery({
    queryKey: ["limits"],
    refetchInterval: 60_000,
    queryFn: async () => {
      const r = await api("/api/limits");
      if (!r.ok) throw new Error(`Limits answered ${r.status}`);
      return (await r.json()) as { at: string; limits: Limits } | null;
    },
  });
  if (!data) return null;
  const now = Date.now();
  const [five, week] = [usedNow(data.limits.fiveHour, now), usedNow(data.limits.sevenDay, now)];
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} aria-label={t("Claude usage: {five}% of 5 hours, {week}% of 7 days", { five, week })} className="mr-1 flex items-center gap-1.5 rounded-full text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span className={cn(pill, tone(five))}><span className="opacity-70">5h</span>{five}%</span>
            <span className={cn(pill, tone(week))}><span className="opacity-70">7d</span>{week}%</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t("5-hour window resets {when}", { when: resets(data.limits.fiveHour) })}</p>
          <p>{t("7-day window resets {when}", { when: resets(data.limits.sevenDay) })}</p>
          <p>{t("Seen by a run {ago}", { ago: ago(data.at, now) })}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
