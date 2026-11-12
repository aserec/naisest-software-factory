import type { RunEvent } from "software-factory/run-events";
import type { T } from "@/lib/i18n";
import { when } from "@/lib/utils";
import type { BoardRow } from "@/server/seams";
import { Badge } from "./ui/badge";
import { SectionHeading } from "./shell";
import { useT } from "./use-preferences";

export const MERGE_EVENTS = ["change_state", "gate_check", "decision"] as const;

// What stops the change from merging now, as the code host tells the board, with the pill colour of a step outcome.
function status(i: BoardRow, t: T): [string, "positive" | "warning" | "destructive"] {
  if (i.state === "done") return [t("Merged"), "positive"];
  if (i.conflicts) return [t("Has conflicts with the base branch"), "destructive"];
  if (i.checksFailed) return [t("A check of the change failed"), "destructive"];
  if (i.mergeBlock) return [t("Cannot merge: {block}", { block: i.mergeBlock }), "warning"];
  return [t("Can merge"), "positive"];
}

function line(e: RunEvent, t: T) {
  if (e.type === "change_state") return t(e.data.conflicts ? "Conflicts with the base branch. The factory started a conflict round." : "The conflicts are gone.");
  if (e.type === "gate_check") return e.data.exitCode === 0 ? t("Build check passed: {command}", { command: e.data.command }) : t("Build check failed with exit code {code}: {command}", { code: e.data.exitCode, command: e.data.command });
  if (e.type === "decision") return t(e.data.auto ? "The change passed every check and went to merge." : "The change passed its checks and waits for a person to merge it.");
}

// The current merge status of the work item's change, and every conflict round, build check and decision across its runs.
// item: the board card, absent when the board did not load. events: the work item's MERGE_EVENTS, oldest first.
// children: this run's conflict rounds, each with its steps, shown before the list of events.
export function MergeProblems({ item, events, run, children }: { item?: BoardRow; events: RunEvent[]; run: string; children?: React.ReactNode }) {
  const t = useT();
  if (!item?.changeUrl && !events.length) return null;
  const [said, variant] = item?.changeUrl ? status(item, t) : [];
  return (
    <section className="mt-8">
      <SectionHeading>
        {t("Merge problems")}
        {said && <Badge variant={variant}>{said}</Badge>}
      </SectionHeading>
      {children}
      {events.length > 0 && <SectionHeading as="h3">{t("Merge history")}</SectionHeading>}
      <ol>
        {events.map((e) => (
          <li key={e.id} className="flex flex-wrap gap-x-4 border-b border-rule py-2 last:border-0">
            <time dateTime={e.at} className="w-44 flex-none text-muted-foreground">{when(e.at)}</time>
            <span className={`flex-1 ${e.type === "gate_check" && e.data.exitCode !== 0 ? "text-destructive" : ""}`}>{line(e, t)}</span>
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
