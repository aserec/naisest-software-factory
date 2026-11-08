import { auth } from "@/server/auth";
import { getDb } from "@/server/db-instance";

export const dynamic = "force-dynamic";

// The plan's 5-hour and 7-day usage, as the newest Claude Code run saw it. null until a run reported it.
export async function GET() {
  if (!(await auth())) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json(getDb().latestLimits() ?? null);
}
