import { randomUUID } from "node:crypto";
import type { ControlRequest } from "software-factory/run-events";
import { auth } from "@/server/auth";
import { controlUser } from "@/server/control-user";
import { getDb } from "@/server/db-instance";

type Ctx = { params: Promise<{ run: string; action: string }> };
const KINDS = ["stop", "resume", "restart"] as const;

// What the run page needs to pick its buttons: the last state label, whether a pipeline cancel ended it, and what is waiting.
export async function GET(_req: Request, { params }: Ctx) {
  const { run, action } = await params;
  if (action !== "state") return new Response("not found", { status: 404 });
  if (!(await auth())) return new Response("sign in first", { status: 401 });
  const db = getDb();
  const first = db.events({ run, limit: 1 }).events[0];
  if (!first) return new Response("run not found", { status: 404 });
  const mine = db.requests({ target: first.target }).filter((r) => r.run === run);
  const labels = db.events({ run }).events.filter((e) => e.type === "label_change"); // ponytail: the first 500 events only; add paging if a run passes that before its last label
  return Response.json({
    label: labels.at(-1)?.data.to as string | undefined,
    cancelled: mine.some((r) => r.outcome === "cancelled"),
    // A cancelled stop stays pending (Ruling R4) but nothing waits for it any more.
    pending: mine.filter((r) => !r.doneAt && r.outcome !== "cancelled").map((r) => r.kind),
  });
}

export async function POST(_req: Request, { params }: Ctx) {
  const { run, action } = await params;
  const kind = KINDS.find((k) => k === action);
  if (!kind) return new Response("not found", { status: 404 });
  const user = await controlUser();
  if (typeof user !== "string") return user;
  const db = getDb();
  const first = db.events({ run, limit: 1 }).events[0];
  if (!first) return new Response("run not found", { status: 404 });
  const row = db.request({ kind, run, target: first.target, ticket: first.ticket, user });
  if ("refused" in row) return new Response(row.refused, { status: 409 });
  db.addEvents([{ id: randomUUID(), run, at: row.at, target: first.target, ticket: first.ticket, type: kind, data: { user } }]);
  return Response.json(row satisfies ControlRequest);
}
