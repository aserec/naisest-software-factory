"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { RANGES } from "@/server/insights"; // types and Intl only, safe in the browser

export type RangeQuery = { range: string; from?: string; to?: string };

// The one style for a select or date field. globals.css draws the select arrow.
export const field = "h-8 rounded-md border border-input bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

// One row as tall as a button. Picking a custom range adds the two dates to the right in the same row, so nothing below moves.
export function RangePicker({ value, onPick }: { value: RangeQuery; onPick: (q: RangeQuery) => void }) {
  const [custom, setCustom] = useState(value.range === "custom");
  const [days, setDays] = useState({ from: value.from ?? "", to: value.to ?? "" });
  return (
    <form
      className="flex min-h-8 flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (days.from && days.to) onPick({ range: "custom", from: days.from, to: days.to });
      }}
    >
      <label className="sr-only" htmlFor="range">
        Range
      </label>
      <select
        id="range"
        className={field}
        value={custom ? "custom" : value.range}
        onChange={(e) => {
          const v = e.target.value;
          setCustom(v === "custom");
          if (v !== "custom") onPick({ range: v });
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
