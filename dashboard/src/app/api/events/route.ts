import { DASHBOARD_TYPES, EVENT_DATA, runEvent, type RunEvent } from "software-factory/run-events";
import { auth, factoryAuthorized } from "@/server/auth";
import { getDb } from "@/server/db-instance";

const MAX_EVENTS = 500;
const bad = (error: string) => Response.json({ error }, { status: 400 });

export async function POST(req: Request) {
  if (!factoryAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body: unknown = await req.json().catch(() => undefined);
  if (!Array.isArray(body)) return bad("body must be an array of events");
  if (body.length > MAX_EVENTS) return bad(`at most ${MAX_EVENTS} events per request`);
  const events: RunEvent[] = [];
  for (let i = 0; i < body.length; i++) {
    const r = runEvent.safeParse(body[i]);
    if (!r.success) return bad(`event ${i} is not valid: ${r.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`);
    if (DASHBOARD_TYPES.has(r.data.type)) return bad(`event ${i} has type ${r.data.type}, which only the dashboard writes`);
    // runEvent only checks data. Parse it again to drop keys the type does not know (passthrough types keep theirs).
    events.push({ ...r.data, data: EVENT_DATA[r.data.type].parse(r.data.data) });
  }
  return Response.json({ added: getDb().addEvents(events) });
}

// Live view and history are this one query: the page asks again with the cursor it got last.
export async function GET(req: Request) {
  if (!(await auth())) return Response.json({ error: "unauthorized" }, { status: 401 });
  const q = new URL(req.url).searchParams;
  const run = q.get("run");
  const after = Number(q.get("after") ?? 0);
  if (!run || !Number.isInteger(after) || after < 0) return bad("run and a whole number after are required");
  return Response.json(getDb().events({ run, after }));
}
