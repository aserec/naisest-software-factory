import { auth } from "@/server/auth";
import { getDb } from "@/server/db-instance";
import { factoryStatus } from "@/server/factory-status";
import { readTargets } from "@/server/targets";

export const dynamic = "force-dynamic";

// Which targets have a factory that polls, for the menu and the boards.
export async function GET() {
  if (!(await auth())) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json(factoryStatus(readTargets().map((t) => t.name), getDb().factoriesSeen(), new Date(), getDb().factoriesPolling()));
}
