import { RunControls } from "@/components/run-controls";
import { RunTimeline } from "@/components/run-timeline";
import { PageTitle } from "@/components/shell";
import { getDb } from "@/server/db-instance";
import { Button } from "@/components/ui/button";
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
  const changeUrl = item?.state === "needs_approval" ? summary?.changeUrl : undefined;
  // Review findings link their file into the change's diff once the change exists.
  const fileLink = target && summary?.changeUrl ? fileLinkOf(target, summary.changeUrl) : undefined;
  // A target whose tracker is unknown still gets its page, only without the work item link.
  let tracker: ReturnType<typeof trackerOf> | undefined;
  try {
    tracker = target && trackerOf(target);
  } catch {}
  const ticketUrl = item?.url || (target && tracker?.ticketUrl(target, first.ticket));
  return (
    // From lg the open side panel sits beside the page instead of over it; see the panel width in ui/sheet.tsx.
    <main className="transition-[padding] duration-300 ease-[cubic-bezier(0.2,0,0,1)] lg:has-[[data-panel=open]]:pr-[min(624px,calc(100vw-624px))]">
      <PageTitle
        // The work item's title, as on its board card; without the board, its number.
        title={item?.title ?? (first ? `${first.target} #${first.ticket}` : `Run ${run}`)}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {changeUrl && target && (
              <Button asChild>
                <a href={changeUrl}>Review and merge in {codeHostName(target)}</a>
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
        {tracker && ticketUrl && (
          <>
            {" · "}
            <a href={ticketUrl} className="underline decoration-input underline-offset-4 hover:text-foreground hover:decoration-current">
              Open the work item in {tracker.name}
            </a>
          </>
        )}
      </PageTitle>
      <RunTimeline run={run} limits={target?.stuckMinutes} risk={{ risk: item?.risk, mergeRisk: summary?.mergeRisk, mergeRiskMax: summary?.mergeRiskMax }} state={item?.state} fileLink={fileLink} earlier={runs.filter((r) => r.run !== run)} />
    </main>
  );
}
