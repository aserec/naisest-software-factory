import { Badge } from "@/components/ui/badge";
import { usd, when, words } from "@/lib/utils";
import type { RunSummary } from "@/server/db";
import { SectionHeading } from "./shell";

const OUTCOME_PILL: Record<string, "destructive" | "warning" | "secondary" | "positive"> = { done: "positive", blocked: "destructive", needs_info: "warning" };

// The work item's other runs, newest first, each with a link to its own page.
export function EarlierRuns({ runs }: { runs: RunSummary[] }) {
  if (!runs.length) return null;
  const cell = "py-2 pr-4 text-left font-normal whitespace-nowrap";
  return (
    <section className="mt-8">
      <SectionHeading>Earlier runs</SectionHeading>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem]">
          <thead className="text-muted-foreground">
            <tr className="border-b">
              {["Started", "Outcome", "Last step", "Run"].map((h) => (
                <th key={h} scope="col" className={cell}>
                  {h}
                </th>
              ))}
              <th scope="col" className="py-2 text-right font-normal">
                Cost
              </th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.run} className="border-b border-rule last:border-0">
                <td className={cell}>{when(r.startedAt)}</td>
                <td className={cell}>
                  {/* A run with no run_end may still be paused, so it is not called failed. */}
                  <Badge variant={OUTCOME_PILL[r.outcome ?? ""] ?? "secondary"}>{r.outcome ? words(r.outcome).toLowerCase() : "not ended"}</Badge>
                </td>
                <td className={cell}>{r.lastStep ? words(r.lastStep.step) : <span className="text-muted-foreground">—</span>}</td>
                <td className={cell}>
                  <a href={`/runs/${encodeURIComponent(r.run)}`} className="font-mono text-xs underline decoration-input underline-offset-4 hover:decoration-current">
                    {r.run}
                  </a>
                </td>
                <td className="py-2 text-right">{usd(r.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
