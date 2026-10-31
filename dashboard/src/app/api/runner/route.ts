import { auth } from "@/server/auth";
import { getGitLab } from "@/server/gitlab-instance";
import { hostStats, type LogSource, runnerLogs } from "@/server/grafana";

export const dynamic = "force-dynamic";

// Each part fails on its own, so one slow or broken source never blanks the whole view.
const part = <T,>(p: Promise<T>) => p.catch((err: unknown) => ({ error: err instanceof Error ? err.message : "failed" }));

export async function GET(req: Request) {
  if (!(await auth())) return Response.json({ error: "unauthorized" }, { status: 401 });
  const q = new URL(req.url).searchParams;
  const minutes = Math.min(Math.max(Number(q.get("minutes")) || 15, 1), 24 * 60);
  const [jobs, hosts, logs] = await Promise.all([
    part(getGitLab().runningJobs()),
    part(hostStats()),
    part(runnerLogs({ source: (q.get("source") ?? "docker") as LogSource, host: q.get("host") || undefined, minutes })),
  ]);
  return Response.json({ jobs, hosts, logs });
}
