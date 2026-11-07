import type { RunEvent } from "software-factory/run-events";
import { when } from "@/lib/utils";
import type { BoardRow } from "@/server/seams";
import { SectionHeading } from "./shell";

export const MERGE_EVENTS = ["change_state", "gate_check", "decision"] as const;

// What stops the change from merging now, as the code host tells the board.
function status(i: BoardRow) {
  if (i.state === "done") return "Merged.";
  if (i.conflicts) return "Has conflicts with the base branch.";
  if (i.checksFailed) return "A check of the change failed.";
  if (i.mergeBlock) return `Cannot merge: ${i.mergeBlock}.`;
  return "Can merge.";
}

function line(e: RunEvent) {
  if (e.type === "change_state") return e.data.conflicts ? "Conflicts with the base branch. The factory started a conflict round." : "The conflicts are gone.";
  if (e.type === "gate_check") return `Build check ${e.data.exitCode === 0 ? "passed" : `failed with exit code ${e.data.exitCode}`}: ${e.data.command}`;
  if (e.type === "decision") return e.data.auto ? "The change passed every check and went to merge." : "The change passed its checks and waits for a person to merge it.";
}

// The current merge status of the work item's change, and every conflict round, build check and decision across its runs.
// item: the board card, absent when the board did not load. events: the work item's MERGE_EVENTS, oldest first.
export function MergeProblems({ item, events, run }: { item?: BoardRow; events: RunEvent[]; run: string }) {
  if (!item?.changeUrl && !events.length) return null;
  return (
    <section className="mt-8">
      <SectionHeading>Merge problems</SectionHeading>
      {item?.changeUrl && <p className="mb-2">{status(item)}</p>}
      <ol>
        {events.map((e) => (
          <li key={e.id} className="flex flex-wrap gap-x-4 border-b border-rule py-2 last:border-0">
            <time dateTime={e.at} className="w-44 flex-none text-muted-foreground">{when(e.at)}</time>
            <span className={`flex-1 ${e.type === "gate_check" && e.data.exitCode !== 0 ? "text-destructive" : ""}`}>{line(e)}</span>
            {e.run !== run && (
              <a href={`/runs/${encodeURIComponent(e.run)}`} className="font-mono text-xs leading-6 text-muted-foreground underline decoration-input underline-offset-4 hover:decoration-current">
                {e.run}
              </a>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
