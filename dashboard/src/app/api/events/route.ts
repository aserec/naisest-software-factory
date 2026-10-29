import { runEvent, type RunEvent } from "software-factory/run-events";
import { factoryAuthorized } from "@/server/auth";
import { getDb } from "@/server/db-instance";

const MAX_EVENTS = 500;
const bad = (error: string) => Response.json({ error }, { status: 400 });

export async function POST(req: Request) {
  if (!factoryAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body: unknown = await req.json().catch(() => undefined);
  if (!Array.isArray(body)) return bad("body must be an array of events");
  if (body.length > MAX_EVENTS) return bad(`at most ${MAX_EVENTS} events per request`);
  for (let i = 0; i < body.length; i++) {
    const r = runEvent.safeParse(body[i]);
    if (!r.success) return bad(`event ${i} is not valid: ${r.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`);
  }
  return Response.json({ added: getDb().addEvents(body as RunEvent[]) });
}
