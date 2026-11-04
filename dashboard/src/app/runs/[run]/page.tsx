import { RunControls } from "@/components/run-controls";
import { RunTimeline } from "@/components/run-timeline";
import { PageTitle } from "@/components/shell";
import { getDb } from "@/server/db-instance";
import { Button } from "@/components/ui/button";
import { gitlab } from "@/server/gitlab";
import { getGitLab } from "@/server/gitlab-instance";
import { readTargets } from "@/server/targets";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ run: string }> }) {
  const { run } = await params;
  const first = getDb().events({ run, limit: 1 }).events[0];
  const target = readTargets().find((t) => t.name === first?.target);
  const summary = first && getDb().runs({ target: first.target, ticket: first.ticket }).find((r) => r.run === run);
  // The board is cached for 15 s; without it the page still shows the run, only the triage risk and the MR link are missing.
  const item = first && (await getGitLab().board().catch(() => [])).find((i) => i.target === first.target && i.ticket === first.ticket);
  const mrUrl = item?.state === "factory_needs_approval" ? summary?.mrUrl : undefined;
  return (
    // From lg the open side panel sits beside the page instead of over it; see the panel width in ui/sheet.tsx.
    <main className="transition-[padding] duration-300 ease-[cubic-bezier(0.2,0,0,1)] lg:has-[[data-panel=open]]:pr-[min(624px,calc(100vw-624px))]">
      <PageTitle
        // The work item's title, as on its board card; without GitLab, its number.
        title={item?.title ?? (first ? `${first.target} #${first.ticket}` : `Run ${run}`)}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {mrUrl && (
              <Button asChild>
                <a href={mrUrl}>Review and merge in GitLab</a>
              </Button>
            )}
            <RunControls run={run} state={item?.state} />
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
        {target && (
          <>
            {" · "}
            <a href={target.githubIssues ? `${target.githubIssues}/${first.ticket}` : `${gitlab()}/${target.projectPath}/-/issues/${first.ticket}`} className="underline decoration-input underline-offset-4 hover:text-foreground hover:decoration-current">
              Open the work item in {target.githubIssues ? "GitHub" : "GitLab"}
            </a>
          </>
        )}
      </PageTitle>
      <RunTimeline run={run} limits={target?.stuckMinutes} risk={{ risk: item?.risk, mergeRisk: summary?.mergeRisk, mergeRiskMax: summary?.mergeRiskMax }} state={item?.state} />
    </main>
  );
}
