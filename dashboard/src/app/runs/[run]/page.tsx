import { RunControls } from "@/components/run-controls";
import { RunTimeline } from "@/components/run-timeline";
import { PageTitle } from "@/components/shell";
import { getDb } from "@/server/db-instance";
import { gitlab } from "@/server/gitlab";
import { readTargets } from "@/server/targets";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ run: string }> }) {
  const { run } = await params;
  const first = getDb().events({ run, limit: 1 }).events[0];
  const target = readTargets().find((t) => t.name === first?.target);
  return (
    <main>
      <PageTitle
        title={first ? `${first.target} #${first.ticket}` : `Run ${run}`}
        actions={<RunControls run={run} />}
      >
        <span className="font-mono text-xs">{run}</span>
        {target && (
          <>
            {" · "}
            <a href={target.githubIssues ? `${target.githubIssues}/${first.ticket}` : `${gitlab()}/${target.projectPath}/-/issues/${first.ticket}`} className="text-foreground hover:underline">
              Open the ticket in {target.githubIssues ? "GitHub" : "GitLab"}
            </a>
          </>
        )}
      </PageTitle>
      <RunTimeline run={run} limits={target?.stuckMinutes} />
    </main>
  );
}
