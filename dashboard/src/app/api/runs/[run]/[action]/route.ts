import type { ControlRequest } from "software-factory/run-events";
import { auth } from "@/server/auth";
import { controlUser } from "@/server/control-user";
import { getDb } from "@/server/db-instance";

type Ctx = { params: Promise<{ run: string; action: string }> };
const KINDS = ["stop", "resume", "restart", "ready"] as const;

// What the run page needs to pick its buttons: the run view's state, the actions it allows, whether it was restarted, and what is waiting.
export async function GET(_req: Request, { params }: Ctx) {
  const { run, action } = await params;
  if (action !== "state") return new Response("not found", { status: 404 });
  if (!(await auth())) return new Response("sign in first", { status: 401 });
  const db = getDb();
  const view = db.view(run);
  if (!view) return new Response("run not found", { status: 404 });
  const { state, actions, restarted, pending, refusals } = view;
  return Response.json({ state, actions, restarted, pending, refusals });
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
