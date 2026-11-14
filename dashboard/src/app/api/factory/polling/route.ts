import { factoryAuthorized } from "@/server/auth";
import { getDb } from "@/server/db-instance";

// The poll tick of a target starts (on: true) or ends (on: false), for the menu's spinner (factory-status route).
export async function POST(req: Request) {
  if (!factoryAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => undefined)) as { target?: unknown; on?: unknown } | undefined;
  if (typeof body?.target !== "string" || !body.target || typeof body.on !== "boolean") return Response.json({ error: "target (string) and on (boolean) are required" }, { status: 400 });
  getDb().factoryPolling(body.target, body.on ? new Date().toISOString() : undefined);
  return Response.json({ ok: true });
}
