import { auth } from "@/server/auth";
import { getGitLab } from "@/server/gitlab-instance";

export async function GET(_req: Request, { params }: { params: Promise<{ job: string }> }) {
  if (!(await auth())) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { job } = await params;
  if (!/^\d+$/.test(job)) return Response.json({ error: "job must be a number" }, { status: 400 });
  try {
    return new Response(await getGitLab().jobLog(job), { headers: { "content-type": "text/plain; charset=utf-8" } });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "log failed" }, { status: 502 });
  }
}
