import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentPlan, ControlState, Dashboard, RunEvent, Dispatch } from "../seams";

const FLUSH_EVERY_MS = 1000;
const SEND_AT = 100; // events waiting that start a send at once
const BATCH = 500; // the dashboard takes at most this many per call
const MAX_QUEUE = 5000;
const TIMEOUT_MS = 5000;

// The HTTP adapter for the run dashboard. A slow or dead dashboard never slows a step:
// `send` only queues, and a timer sends in the background.
// With spoolDir, a flush that cannot send writes the rest to a file there, and the next adapter made sends it,
// so a dashboard outage at the end of a step delays its events instead of losing them.
export function makeHttpDashboard(url: string, token: string, fetchFn: typeof fetch = fetch, spoolDir?: string): Dashboard {
  const base = url.replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${token}` };
  const queue: RunEvent[] = spoolDir ? takeSpool(spoolDir) : [];
  let inFlight: RunEvent[] = []; // the batch a fetch is sending now; spooled too, since the dashboard ignores an id it has
  let sending: Promise<void> | undefined;
  let closing = false; // set when flush gives up, so a slow dashboard cannot keep the process alive; a new send clears it

  // A fetch that never answers still ends after TIMEOUT_MS: the abort signal is a hint, the race is the guarantee.
  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => (abort.abort(), reject(new Error(`dashboard did not answer in ${TIMEOUT_MS / 1000} s`))), TIMEOUT_MS)));
    timer!.unref();
    try {
      return await Promise.race([fetchFn(`${base}${path}`, { ...init, headers: { ...headers, ...init.headers }, signal: abort.signal }), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // One line the first time each kind of failure is seen, so a dead dashboard is not silent and not noisy.
  const warned = new Set<string>();
  const warnOnce = (why: string) => {
    if (!warned.has(why)) console.warn(`dashboard: ${why}`), warned.add(why);
  };
  const post = (events: RunEvent[]) => call("/api/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(events) });

  // Returns the events to try again later: none when all went through or were refused for good.
  async function sendBatch(batch: RunEvent[]): Promise<RunEvent[]> {
    try {
      const res = await post(batch);
      if (res.ok) return [];
      if (res.status !== 400) {
        warnOnce(`HTTP ${res.status}`);
        return batch;
      }
    } catch {
      warnOnce("network error");
      return batch;
    }
    // A 400 is permanent: the dashboard refused something in this batch, and retrying it would block every later event.
    // Send each event alone once and drop only the ones it refuses. Type and id only: the event body may hold secrets.
    for (const [i, e] of batch.entries()) {
      try {
        const res = await post([e]);
        if (res.status === 400) console.warn(`dashboard: dropped ${e.type} event ${e.id}, the dashboard refused it`);
        else if (!res.ok) return warnOnce(`HTTP ${res.status}`), batch.slice(i);
      } catch {
        return warnOnce("network error"), batch.slice(i);
      }
    }
    return [];
  }

  async function sendAll() {
    while (queue.length && !closing) {
      inFlight = queue.splice(0, BATCH);
      const failed = await sendBatch(inFlight).finally(() => (inFlight = []));
      if (failed.length) {
        queue.unshift(...failed);
        queue.splice(0, queue.length - MAX_QUEUE); // the oldest go first
        return; // the timer tries again
      }
    }
  }
  const pump = () => (sending ??= sendAll().finally(() => (sending = undefined)));

  setInterval(() => void pump(), FLUSH_EVERY_MS).unref();

  return {
    send(e) {
      closing = false;
      queue.push(e);
      if (queue.length > MAX_QUEUE) queue.shift();
      if (queue.length >= SEND_AT) void pump();
    },
    async flush() {
      closing = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([pump(), new Promise((r) => (timer = setTimeout(r, TIMEOUT_MS)))]);
      clearTimeout(timer);
      closing = true;
      const unsent = [...inFlight, ...queue];
      if (spoolDir && unsent.length) {
        mkdirSync(spoolDir, { recursive: true });
        const file = join(spoolDir, `${Date.now()}-${randomUUID()}.json`);
        writeFileSync(file, JSON.stringify(unsent), { mode: 0o600 });
        queue.length = 0;
        console.warn(`dashboard: kept ${unsent.length} unsent events in ${file} for the next step`);
      }
    },
    async control(target, run) {
      const q = new URLSearchParams({ target, ...(run ? { run } : {}) });
      const res = await call(`/api/factory/control?${q}`);
      if (!res.ok) throw new Error(`dashboard control: HTTP ${res.status}`);
      return (await res.json()) as ControlState;
    },
    async requestDone(id, outcome) {
      const res = await call(`/api/factory/requests/${encodeURIComponent(id)}/done`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ outcome }) });
      if (!res.ok) throw new Error(`dashboard requestDone: HTTP ${res.status}`);
    },
    async polling(target, on) {
      await call("/api/factory/polling", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target, on }) }).then(
        (r) => r.ok || warnOnce(`polling: HTTP ${r.status}`),
        (e) => warnOnce(`polling: ${e instanceof Error ? e.message : e}`),
      );
    },
    async dispatches(target) {
      const res = await call(`/api/factory/dispatches?${new URLSearchParams({ target })}`);
      if (!res.ok) throw new Error(`dashboard dispatches: HTTP ${res.status}`);
      return (await res.json()) as Dispatch[];
    },
    async plans() {
      const res = await call("/api/factory/plans");
      if (!res.ok) throw new Error(`dashboard plans: HTTP ${res.status}`);
      return (await res.json()) as AgentPlan[];
    },
    async planUpdate(id, state, result) {
      const res = await call(`/api/factory/plans/${encodeURIComponent(id)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state, result }) });
      if (res.status === 409) return false;
      if (!res.ok) throw new Error(`dashboard planUpdate: HTTP ${res.status}`);
      return true;
    },
    async history(target, since, types) {
      const q = new URLSearchParams({ target, since });
      for (const t of types) q.append("type", t);
      const res = await call(`/api/factory/history?${q}`);
      if (!res.ok) throw new Error(`dashboard history: HTTP ${res.status}`);
      return (await res.json()) as RunEvent[];
    },
    async dispatchDone(id, workItem) {
      const res = await call(`/api/factory/dispatches/${encodeURIComponent(id)}/done`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workItem }) });
      if (!res.ok) throw new Error(`dashboard dispatchDone: HTTP ${res.status}`);
    },
  };
}

// Takes the events earlier processes could not send. The rename claims a file, so two processes never both take it.
function takeSpool(dir: string): RunEvent[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const events: RunEvent[] = [];
  for (const n of names) {
    const claimed = join(dir, `${n}.${process.pid}.taken`);
    try {
      renameSync(join(dir, n), claimed);
    } catch {
      continue; // another process took it
    }
    try {
      events.push(...(JSON.parse(readFileSync(claimed, "utf8")) as RunEvent[]));
    } catch {
      console.warn(`dashboard: could not read spooled events in ${claimed}`);
      continue; // left for a person to look at
    }
    unlinkSync(claimed);
  }
  return events.slice(-MAX_QUEUE);
}
