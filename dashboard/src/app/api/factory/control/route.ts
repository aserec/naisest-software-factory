import type { ControlState } from "software-factory/run-events";
import { factoryAuthorized } from "@/server/auth";
import { getDb } from "@/server/db-instance";

const RESTART_MS = 15 * 60_000;

export async function GET(req: Request) {
  if (!factoryAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const q = new URL(req.url).searchParams;
  const target = q.get("target");
  if (!target) return Response.json({ error: "target is required" }, { status: 400 });
  const db = getDb();
  // ponytail: reads every request of the target. A human clicks these, so the table stays small; add a done_at filter to Db.requests if it grows.
  const all = db.requests({ target });
  const since = Date.now() - RESTART_MS;
  // A cancelled stop stays pending (the poller still has to see it), so a pending stop only means "stop" when it is not cancelled.
  // Every pending request goes to the poller: between local runs it also finishes a stop no CI cancel reached.
  const stop = all.some((r) => r.kind === "stop" && !r.doneAt && r.run === q.get("run") && r.outcome !== "cancelled");
  const requests = all.filter((r) => !r.doneAt || ((r.kind === "restart" || r.kind === "ready") && Date.parse(r.doneAt) > since));
  const { thresholds, factoryFile, language } = db.settings(target);
  return Response.json({ switches: db.switches(target), stop, requests, settings: { thresholds, ...(factoryFile ? { factoryFile } : {}), ...(language ? { language } : {}) } } satisfies ControlState);
}
