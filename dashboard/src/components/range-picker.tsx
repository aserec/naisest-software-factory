"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { RANGES } from "@/server/insights"; // types and Intl only, safe in the browser

const field = "h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

// The range lives in the URL, so a range can be shared and the server reads it. tz: the viewer's time zone, so
// "today" is the viewer's day. The first visit has none yet, so the picker adds it once.
export function RangePicker({ range, from, to }: { range: string; from?: string; to?: string }) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const [custom, setCustom] = useState(range === "custom");
  const [days, setDays] = useState({ from: from ?? "", to: to ?? "" });
  const go = (q: Record<string, string>) => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    router.replace(`${path}?${new URLSearchParams({ ...q, tz })}`);
  };
  useEffect(() => {
    if (!params.get("tz")) go(Object.fromEntries(params));
    // Once, on the first visit: later visits carry tz in the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (days.from && days.to) go({ range: "custom", from: days.from, to: days.to });
      }}
    >
      <label className="sr-only" htmlFor="range">
        Range
      </label>
      <select
        id="range"
        className={field}
        value={custom ? "custom" : range}
        onChange={(e) => {
          const v = e.target.value;
          setCustom(v === "custom");
          if (v !== "custom") go({ range: v });
        }}
      >
        {Object.entries(RANGES).map(([k, label]) => (
          <option key={k} value={k}>
            {label}
          </option>
        ))}
      </select>
      {custom && (
        <>
          <input type="date" aria-label="From" className={field} value={days.from} max={days.to || undefined} onChange={(e) => setDays({ ...days, from: e.target.value })} required />
          <span className="text-muted-foreground">to</span>
          <input type="date" aria-label="To" className={field} value={days.to} min={days.from || undefined} onChange={(e) => setDays({ ...days, to: e.target.value })} required />
          <Button type="submit" variant="outline">
            Show
          </Button>
        </>
      )}
    </form>
  );
}
