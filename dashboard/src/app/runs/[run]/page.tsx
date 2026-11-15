import { RunControls, RunLinks, Tr } from "@/components/run-controls";
import { RunTimeline } from "@/components/run-timeline";
import { PageTitle, RunTarget } from "@/components/shell";
import { getDb } from "@/server/db-instance";
import { Badge } from "@/components/ui/badge";
import { ConflictsBadge } from "@/components/board";
import { MERGE_EVENTS } from "@/components/merge-problems";
import { STATE } from "@/lib/state";
import { codeHostName, fileLinkOf, getBoard, trackerOf } from "@/server/compose";
import { readTargets } from "@/server/targets";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ run: string }> }) {
  const { run } = await params;
  const first = getDb().events({ run, limit: 1 }).events[0];
  const target = readTargets().find((t) => t.name === first?.target);
  // Every run of the work item, newest first: this one's summary, and the others for "Earlier runs".
  const runs = first ? getDb().runs({ target: first.target, ticket: first.ticket }) : [];
  const summary = runs.find((r) => r.run === run);
  const changes = first ? getDb().stateChanges([first]) : [];
  // The board is cached for 5 s; without it the page still shows the run, only the triage risk and the change link are missing.
  const item = first && (await getBoard().board().catch(() => [])).find((i) => i.target === first.target && i.ticket === first.ticket);
  const changeUrl = summary?.changeUrl;
  // Review findings link their file into the change's diff once the change exists.
  const fileLink = target && summary?.changeUrl ? fileLinkOf(target, summary.changeUrl) : undefined;
  const tracker = target && trackerOf(target);
  const ticketUrl = item?.url || (target && tracker?.ticketUrl(target, first.ticket));
  return (
    // From lg the open side panel sits beside the page instead of over it; see the panel width in ui/sheet.tsx.
    <main className="transition-[padding] duration-300 ease-[cubic-bezier(0.2,0,0,1)] lg:has-[[data-panel=open]]:pr-[min(624px,calc(100vw-624px))]">
      <RunTarget target={first?.target} />
      <PageTitle
        // The work item's title, as on its board card; without the board, its number.
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {item?.title ?? (first ? `${first.target} #${first.ticket}` : <Tr text="Run {id}" values={{ id: run }} />)}
            {/* The ticket's board column now; absent when the board did not load. */}
            {item?.state && <Badge variant="outline"><Tr text={STATE[item.state]} /></Badge>}
            <ConflictsBadge conflicts={summary?.conflicts} />
          </span>
        }
        actions={
          // basis-full: the buttons always take their own line under the title, whatever fits beside it.
          <div className="flex basis-full flex-wrap items-center gap-2">
            <RunLinks changeUrl={changeUrl} approving={item?.state === "needs_approval"} codeHost={target && codeHostName(target)} ticketUrl={ticketUrl || undefined} tracker={tracker?.name} boardUrl={item?.boardUrl} />
            <RunControls run={run} />
          </div>
        }
      >
        {first && (
          <>
            <span className="font-mono">
              {first.target} #{first.ticket}
            </span>
            {" · "}
          </>
        )}
        <span className="font-mono">{run}</span>
      </PageTitle>
      <RunTimeline run={run} limits={target?.stuckMinutes} risk={{ risk: item?.risk, mergeRisk: summary?.mergeRisk, mergeRiskMax: summary?.mergeRiskMax }} state={item?.state} fileLink={fileLink} earlier={runs.filter((r) => r.run !== run)} changes={changes} merge={{ item, events: first ? getDb().itemEvents(first, [...MERGE_EVENTS]) : [] }} />
    </main>
  );
}
