import type { ControlRequest } from "software-factory/run-events";
import { auth } from "@/server/auth";
import { controlUser } from "@/server/control-user";
import { getDb } from "@/server/db-instance";

type Ctx = { params: Promise<{ run: string; action: string }> };
const KINDS = ["stop", "resume", "restart"] as const;

// What the run page needs to pick its buttons: the last state, whether a pipeline cancel ended it, whether it was restarted, and what is waiting.
export async function GET(_req: Request, { params }: Ctx) {
  const { run, action } = await params;
  if (action !== "state") return new Response("not found", { status: 404 });
  if (!(await auth())) return new Response("sign in first", { status: 401 });
  const db = getDb();
  const first = db.events({ run, limit: 1 }).events[0];
  if (!first) return new Response("run not found", { status: 404 });
  const mine = db.requests({ target: first.target }).filter((r) => r.run === run);
  return Response.json({
    state: db.state(run),
    cancelled: mine.some((r) => r.outcome === "cancelled"),
    // A done restart ended this run, so nothing is left to press.
    restarted: db.restarted(run),
    // A cancelled stop stays pending (Ruling R4) but nothing waits for it any more.
    pending: mine.filter((r) => !r.doneAt && r.outcome !== "cancelled").map((r) => r.kind),
  });
}

export async function POST(req: Request, { params }: Ctx) {
  const { run, action } = await params;
  const kind = KINDS.find((k) => k === action);
  if (!kind) return new Response("not found", { status: 404 });
  const user = await controlUser(req);
  if (typeof user !== "string") return user;
  const db = getDb();
  const first = db.events({ run, limit: 1 }).events[0];
  if (!first) return new Response("run not found", { status: 404 });
  const row = db.request({ kind, run, target: first.target, ticket: first.ticket, user });
  if ("refused" in row) return new Response(row.refused, { status: 409 });
  return Response.json(row satisfies ControlRequest);
}
