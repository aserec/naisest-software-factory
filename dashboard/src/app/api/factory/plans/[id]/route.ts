import { factoryAuthorized } from "@/server/auth";
import { getDb } from "@/server/db-instance";

const STATES = ["running", "done", "failed"] as const;

// The fix worker claims a plan (running) and ends it (done or failed). 409: the plan is not in a state that allows the move.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!factoryAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => undefined)) as { state?: unknown; result?: unknown } | undefined;
  const state = STATES.find((s) => s === body?.state);
  if (!state) return Response.json({ error: "state must be running, done or failed" }, { status: 400 });
  const result = body?.result;
  if (result !== undefined && (typeof result !== "string" || result.length > 2000)) return Response.json({ error: "result must be a string of at most 2000 characters" }, { status: 400 });
  const plan = getDb().updatePlan((await params).id, state, result);
  return plan ? Response.json(plan) : Response.json({ error: "the plan is not in a state that allows this move" }, { status: 409 });
}
