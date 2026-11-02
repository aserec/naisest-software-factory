import { factoryAuthorized } from "@/server/auth";
import { getDb } from "@/server/db-instance";

// The dispatches job reads the pending dispatches of its target.
export async function GET(req: Request) {
  if (!factoryAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const target = new URL(req.url).searchParams.get("target");
  if (!target) return Response.json({ error: "target is required" }, { status: 400 });
  return Response.json(getDb().dispatches(target));
}
