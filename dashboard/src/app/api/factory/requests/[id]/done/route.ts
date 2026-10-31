import { factoryAuthorized } from "@/server/auth";
import { getDb } from "@/server/db-instance";

const OUTCOMES = ["stopped", "cancelled", "done", "refused"] as const;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!factoryAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => undefined)) as { outcome?: unknown } | undefined;
  const outcome = OUTCOMES.find((o) => o === body?.outcome);
  if (!outcome) return Response.json({ error: `outcome must be one of ${OUTCOMES.join(", ")}` }, { status: 400 });
  getDb().finish((await params).id, outcome);
  return Response.json({ ok: true });
}
