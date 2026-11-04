import { auth } from "@/server/auth";
import { getCi, getHostMetrics } from "@/server/compose";
import { NotSetUp } from "@/server/not-set-up";

export const dynamic = "force-dynamic";

// Each part fails on its own, so one slow or broken source never blanks the whole view. A source with no settings is "unset", not an error.
const part = <T,>(p: Promise<T>) =>
  p.catch((err: unknown) => (err instanceof NotSetUp ? { unset: err.message } : { error: err instanceof Error ? err.message : "failed" }));

export async function GET(req: Request) {
  if (!(await auth())) return Response.json({ error: "unauthorized" }, { status: 401 });
  const q = new URL(req.url).searchParams;
  const minutes = Math.min(Math.max(Number(q.get("minutes")) || 15, 1), 24 * 60);
  const metrics = getHostMetrics();
  const asked = q.get("source") ?? "";
  const source = metrics.sources.includes(asked) ? asked : metrics.sources[0] ?? ""; // an unknown source falls back to the first
  const [jobs, hosts, logs] = await Promise.all([
    part(getCi().runningJobs()),
    part(metrics.hostStats()),
    part(metrics.logs({ source, host: q.get("host") || undefined, minutes })),
  ]);
  return Response.json({ jobs, hosts, logs, sources: metrics.sources });
}
