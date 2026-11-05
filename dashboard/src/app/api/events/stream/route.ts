import { auth } from "@/server/auth";
import { getDb } from "@/server/db-instance";

// How often the stream asks the database, how often it sends a heartbeat so proxies keep the connection,
// and how long an ended run stays quiet before the stream ends (late events, such as the last usage, still arrive).
const POLL_MS = 500;
const HEARTBEAT_MS = 15_000;
const QUIET_MS = 10_000;
const PAGE = 500;

// The run's events as Server-Sent Events: one message per batch, its id the last seq, so a reconnect's Last-Event-ID
// carries on after it. The first message is sent even when empty, so the page knows the run has no events yet.
// Auth: the proxy lets /api/events* through for the factory's token, so this route checks the session like GET /api/events.
export async function GET(req: Request) {
  if (!(await auth())) return Response.json({ error: "unauthorized" }, { status: 401 });
  const q = new URL(req.url).searchParams;
  const run = q.get("run");
  let cursor = Number(req.headers.get("last-event-id") ?? q.get("after") ?? 0);
  if (!run || !Number.isInteger(cursor) || cursor < 0) return Response.json({ error: "run and a whole number after are required" }, { status: 400 });
  const enc = new TextEncoder();
  let stop = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      let quietSince = Date.now();
      let first = true;
      const send = (text: string) => c.enqueue(enc.encode(text));
      const tick = () => {
        const events: ReturnType<ReturnType<typeof getDb>["events"]>["events"] = [];
        for (;;) {
          const page = getDb().events({ run, after: cursor, limit: PAGE });
          events.push(...page.events);
          cursor = page.cursor;
          if (page.events.length < PAGE) break;
        }
        if (events.length || first) send(`id: ${cursor}\ndata: ${JSON.stringify(events)}\n\n`);
        first = false;
        if (events.length) quietSince = Date.now();
        else if (Date.now() - quietSince >= QUIET_MS && getDb().ended(run)) {
          // A named event, so the page closes its EventSource instead of reconnecting.
          send("event: end\ndata: \n\n");
          stop();
        }
      };
      const poll = setInterval(tick, POLL_MS);
      const beat = setInterval(() => send(": heartbeat\n\n"), HEARTBEAT_MS);
      stop = () => {
        clearInterval(poll);
        clearInterval(beat);
        req.signal.removeEventListener("abort", stop);
        try {
          c.close();
        } catch {} // already closed or cancelled
      };
      req.signal.addEventListener("abort", stop);
      tick();
    },
    cancel: () => stop(),
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
}
