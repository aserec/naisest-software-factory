import { factoryAuthorized } from "@/server/auth";
import { getDb } from "@/server/db-instance";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!factoryAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  getDb().dispatchDone((await params).id);
  return Response.json({ ok: true });
}
