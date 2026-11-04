import { auth } from "@/server/auth";
import { getCi } from "@/server/compose";

export async function GET(_req: Request, { params }: { params: Promise<{ job: string }> }) {
  if (!(await auth())) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { job } = await params;
  // A CI adapter may check the id again for its own format.
  if (!/^[\w.-]+$/.test(job)) return Response.json({ error: "job must be letters, digits, dot, dash or underscore" }, { status: 400 });
  try {
    return new Response(await getCi().jobLog(job), { headers: { "content-type": "text/plain; charset=utf-8" } });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "log failed" }, { status: 502 });
  }
}
