import { EVENT_TYPES, type EventType } from "software-factory/run-events";
import { factoryAuthorized } from "@/server/auth";
import { getDb } from "@/server/db-instance";

const LIMIT = 5000;

// The weekly improve job reads the past events of its target.
export async function GET(req: Request) {
  if (!factoryAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const p = new URL(req.url).searchParams;
  const target = p.get("target");
  if (!target) return Response.json({ error: "target is required" }, { status: 400 });
  const since = p.get("since") ?? "";
  if (Number.isNaN(Date.parse(since))) return Response.json({ error: "since must be a date" }, { status: 400 });
  const types = p.getAll("type");
  if (!types.every((t): t is EventType => (EVENT_TYPES as readonly string[]).includes(t))) return Response.json({ error: "unknown type" }, { status: 400 });
  return Response.json(getDb().history({ target, since: new Date(since).toISOString(), types, limit: LIMIT }));
}
