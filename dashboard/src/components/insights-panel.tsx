"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { InsightsPayload } from "@/server/insights-load";
import { InsightsView } from "./insights-view";
import { RangePicker, type RangeQuery } from "./range-picker";
import { LoadError, PageTitle } from "./shell";

const toSearch = (q: Record<string, string | undefined>) => new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => !!e[1])).toString();
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

// The page's title, the range and the figures. A new range loads here, not by leaving the page: the old figures
// stay, dimmed, until the new ones come, and then every bar grows or shrinks to its new size.
// initial: what the server rendered for the URL. hasZone: whether that URL carried the viewer's time zone.
export function InsightsPanel({ initial, hasZone }: { initial: InsightsPayload; hasZone: boolean }) {
  const [q, setQ] = useState<RangeQuery & { tz: string }>({ range: initial.range, from: initial.fromDay, to: initial.toDay, tz: initial.tz });
  // A first visit has no time zone in the URL, so the server counted in UTC. Ask again in the viewer's own.
  useEffect(() => {
    if (!hasZone) pick({ range: initial.range, from: initial.fromDay, to: initial.toDay });
    // Once, on the first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const search = toSearch(q);
  const [first] = useState(search);
  const query = useQuery({
    queryKey: ["insights", search],
    placeholderData: keepPreviousData,
    initialData: search === first ? initial : undefined, // only the range the server rendered
    staleTime: 30_000,
    queryFn: async () => {
      const r = await api(`/api/insights?${search}`);
      if (!r.ok) throw new Error(`Insights answered ${r.status}`);
      return (await r.json()) as InsightsPayload;
    },
  });
  function pick(next: RangeQuery) {
    const n = { ...next, tz: browserZone() };
    setQ(n);
    // The URL keeps the range so a link shares it, without a navigation.
    window.history.replaceState(null, "", `?${toSearch(n)}`);
  }
  const shown = query.data ?? initial;
  return (
    <>
      <PageTitle title="Insights">
        {shown.said}, every target, by when each run started. Times in {shown.tz}.
      </PageTitle>
      <div className="-mt-4 mb-6">
        <RangePicker value={q} onPick={pick} />
      </div>
      {query.error && <LoadError what="Insights" query={query} className="mb-6" />}
      <div aria-busy={query.isFetching} className={`transition-opacity duration-300 ${query.isFetching ? "opacity-50" : ""}`}>
        <InsightsView data={shown.data} />
      </div>
    </>
  );
}
