import { factoryAuthorized } from "@/server/auth";
import { getDb } from "@/server/db-instance";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!factoryAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  // The url of the work item it opened; an old factory sends no body. Only http(s), as the page puts it in a link.
  const { workItem } = ((await req.json().catch(() => undefined)) ?? {}) as { workItem?: unknown };
  getDb().dispatchDone((await params).id, typeof workItem === "string" && /^https?:\/\//.test(workItem) ? workItem : undefined);
  return Response.json({ ok: true });
}
