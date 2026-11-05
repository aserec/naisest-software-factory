import { auth } from "@/server/auth";
import { getDb } from "@/server/db-instance";

export const dynamic = "force-dynamic";

// The bell's history: how the latest runs ended, newest first. The page keeps what it has read.
export async function GET() {
  if (!(await auth())) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json(getDb().recent({ types: ["run_end"], limit: 50 }));
}
