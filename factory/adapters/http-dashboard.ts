import type { ControlState, Dashboard, RunEvent } from "../seams";

const FLUSH_EVERY_MS = 1000;
const SEND_AT = 100; // events waiting that start a send at once
const BATCH = 500; // the dashboard takes at most this many per call
const MAX_QUEUE = 5000;
const TIMEOUT_MS = 5000;

// The HTTP adapter for the run dashboard. A slow or dead dashboard never slows a step:
// `send` only queues, and a timer sends in the background.
export function makeHttpDashboard(url: string, token: string, fetchFn: typeof fetch = fetch): Dashboard {
  const base = url.replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${token}` };
  const queue: RunEvent[] = [];
  let sending: Promise<void> | undefined;

  // A fetch that never answers still ends after TIMEOUT_MS: the abort signal is a hint, the race is the guarantee.
  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => (abort.abort(), reject(new Error(`dashboard did not answer in ${TIMEOUT_MS / 1000} s`))), TIMEOUT_MS)));
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
    while (queue.length) {
      const failed = await sendBatch(queue.splice(0, BATCH));
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
      queue.push(e);
      if (queue.length > MAX_QUEUE) queue.shift();
      if (queue.length >= SEND_AT) void pump();
    },
    async flush() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([pump(), new Promise((r) => (timer = setTimeout(r, TIMEOUT_MS)))]);
      clearTimeout(timer);
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
  };
}
