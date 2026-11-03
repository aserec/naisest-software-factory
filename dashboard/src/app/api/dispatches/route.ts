import { dispatchInput } from "software-factory/run-events";
import { factoryAuthorized } from "@/server/auth";
import { getDb } from "@/server/db-instance";
import { getCi } from "@/server/gitlab-instance";
import { startDispatches } from "@/server/loop";
import { readTargets } from "@/server/targets";

// The hook for outside systems: a cron audit, a monitor, any system that needs the factory to act POSTs one dispatch here.
// The dashboard starts the factory's dispatch run at once, and that run turns it into a ticket the same way the watcher does.
export async function POST(req: Request) {
  if (!factoryAuthorized(req, "FACTORY_DISPATCH_TOKEN")) return Response.json({ error: "unauthorized" }, { status: 401 });
  const r = dispatchInput.safeParse(await req.json().catch(() => undefined));
  if (!r.success) return Response.json({ error: r.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ") }, { status: 400 });
  // A dispatch for an unknown target would wait forever: no run reads it.
  if (!readTargets().some((t) => t.name === r.data.target)) return Response.json({ error: `unknown target ${r.data.target}` }, { status: 400 });
  const db = getDb();
  const { id } = db.addDispatch(r.data);
  // Saved first: if the start fails, the loop starts the run later. 202, because the ticket comes later.
  await startDispatches({ db, gitlab: getCi(), now: new Date() });
  return Response.json({ id }, { status: 202 });
}
