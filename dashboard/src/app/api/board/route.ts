import { auth } from "@/server/auth";
import { boardWithRuns } from "@/server/board";
import { getDb } from "@/server/db-instance";
import { getBoard } from "@/server/compose";
import { readTargets } from "@/server/targets";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await auth())) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    return Response.json(boardWithRuns(await getBoard().board(), getDb(), readTargets(), new Date()));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "board failed" }, { status: 502 });
  }
}
