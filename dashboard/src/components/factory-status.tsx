"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { when } from "@/lib/utils";
import type { FactoryStatus } from "@/server/factory-status";
import { useT } from "./use-preferences";

// Shared by the menu and the boards: one fetch every 5 s, so the menu catches a poll tick of a few seconds.
export function useFactoryStatus() {
  return useQuery({
    queryKey: ["factory-status"],
    refetchInterval: 5_000,
    queryFn: async () => {
      const r = await api("/api/factory-status");
      if (!r.ok) throw new Error(`The factory status answered ${r.status}`);
      return (await r.json()) as FactoryStatus[];
    },
  });
}

// One line per target whose factory is down: on the overview every target, on a target board only that target.
export function FactoryDown({ target = "" }: { target?: string }) {
  const t = useT();
  const down = useFactoryStatus().data?.filter((s) => s.down && (!target || s.target === target)) ?? [];
  if (down.length === 0) return null;
  return (
    <div role="alert" className="mb-6 flex flex-col gap-1 rounded-lg border border-destructive/40 bg-pill-negative px-4 py-3 text-pill-negative-ink">
      {down.map((s) => (
        <p key={s.target}>
          <span className="font-mono">{s.target}</span>:{" "}
          {t("the factory is down. It last polled at {time}.", { time: when(s.lastSeen ?? "") })}{" "}
          {t("Nothing runs and no stop or restart is carried out until it starts again.")}
        </p>
      ))}
    </div>
  );
}
