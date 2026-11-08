import { factoryAuthorized } from "@/server/auth";
import { getDb } from "@/server/db-instance";

// The approved plans, oldest first, for the fix worker.
export async function GET(req: Request) {
  if (!factoryAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json(getDb().approvedPlans());
}
