import { RunControls } from "@/components/run-controls";
import { RunTimeline } from "@/components/run-timeline";
import { PageTitle } from "@/components/shell";
import { getDb } from "@/server/db-instance";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConflictsBadge } from "@/components/board";
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
  // The board is cached for 15 s; without it the page still shows the run, only the triage risk and the change link are missing.
  const item = first && (await getBoard().board().catch(() => [])).find((i) => i.target === first.target && i.ticket === first.ticket);
  const changeUrl = summary?.changeUrl;
  // Review findings link their file into the change's diff once the change exists.
  const fileLink = target && summary?.changeUrl ? fileLinkOf(target, summary.changeUrl) : undefined;
  const tracker = target && trackerOf(target);
  const ticketUrl = item?.url || (target && tracker?.ticketUrl(target, first.ticket));
  return (
    // From lg the open side panel sits beside the page instead of over it; see the panel width in ui/sheet.tsx.
    <main className="transition-[padding] duration-300 ease-[cubic-bezier(0.2,0,0,1)] lg:has-[[data-panel=open]]:pr-[min(624px,calc(100vw-624px))]">
      <PageTitle
        // The work item's title, as on its board card; without the board, its number.
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {item?.title ?? (first ? `${first.target} #${first.ticket}` : `Run ${run}`)}
            {/* The ticket's board column now; absent when the board did not load. */}
            {item?.state && <Badge variant="outline">{STATE[item.state]}</Badge>}
            <ConflictsBadge conflicts={summary?.conflicts} />
          </span>
        }
        actions={
          // basis-full: the buttons always take their own line under the title, whatever fits beside it.
          <div className="flex basis-full flex-wrap items-center gap-2">
            {/* Open PR is the main button while the change waits for a person's merge. */}
            {changeUrl && target && (
              <Button asChild variant={item?.state === "needs_approval" ? "default" : "outline"}>
                <a href={changeUrl} target="_blank" rel="noreferrer" title={`Review and merge in ${codeHostName(target)}`}>Open PR</a>
              </Button>
            )}
            {tracker && ticketUrl && (
              <Button asChild variant="outline">
                <a href={ticketUrl} target="_blank" rel="noreferrer" title={`Open the work item in ${tracker.name}`}>Open issue</a>
              </Button>
            )}
            {item?.boardUrl && (
              <Button asChild variant="outline">
                <a href={item.boardUrl} target="_blank" rel="noreferrer" title={`Open the board in ${tracker?.name ?? "the tracker"}`}>Open board</a>
              </Button>
            )}
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
      <RunTimeline run={run} limits={target?.stuckMinutes} risk={{ risk: item?.risk, mergeRisk: summary?.mergeRisk, mergeRiskMax: summary?.mergeRiskMax }} state={item?.state} fileLink={fileLink} earlier={runs.filter((r) => r.run !== run)} />
    </main>
  );
}
