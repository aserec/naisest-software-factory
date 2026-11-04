import { EVENT_TYPES, HISTORY_LIMIT, type EventType } from "software-factory/run-events";
import { factoryAuthorized } from "@/server/auth";
import { getDb } from "@/server/db-instance";

// The weekly improve job reads the past events of its target.
export async function GET(req: Request) {
  if (!factoryAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const p = new URL(req.url).searchParams;
  const target = p.get("target");
  if (!target) return Response.json({ error: "target is required" }, { status: 400 });
  const since = p.get("since") ?? "";
  if (Number.isNaN(Date.parse(since))) return Response.json({ error: "since must be a date" }, { status: 400 });
  const types = [...new Set(p.getAll("type"))];
  if (types.length === 0) return Response.json({ error: "at least one type is required" }, { status: 400 });
  if (!types.every((t): t is EventType => (EVENT_TYPES as readonly string[]).includes(t))) return Response.json({ error: "unknown type" }, { status: 400 });
  return Response.json(getDb().history({ target, since: new Date(since).toISOString(), types, limit: HISTORY_LIMIT }));
}
