import { NotSetUp } from "./not-set-up";

// Runner VM logs (Loki) and disk and memory (node metrics), read through Grafana with a Viewer service account token.
export const SOURCES = ["docker", "gitlab-runner", "system"] as const;
export type LogSource = (typeof SOURCES)[number];
export interface LogLine {
  at: string;
  host: string;
  line: string;
}
export interface HostStat {
  host: string;
  diskUsedPct: number;
  memUsedPct: number;
}

const LIMIT = 500;
const SEL = 'job="factory-runner"';

async function grafana<T>(uid: string | undefined, path: string, params: Record<string, string>, fetchFn: typeof fetch): Promise<T> {
  const base = (process.env.GRAFANA_URL ?? "").replace(/\/+$/, "");
  if (!base || !uid) throw new NotSetUp("Grafana is not set up. Set GRAFANA_URL, METRICS_UID and LOKI_UID to see the hosts and their logs.");
  const r = await fetchFn(`${base}/api/datasources/proxy/uid/${uid}${path}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${process.env.GRAFANA_TOKEN ?? ""}` } });
  if (!r.ok) throw new Error(`Grafana answered ${r.status}${r.status === 401 || r.status === 403 ? ", so check GRAFANA_TOKEN" : ""}.`);
  return ((await r.json()) as { data: T }).data;
}

// Newest first. JSON.stringify quotes the host, so a host from the URL cannot change the query.
export async function runnerLogs(q: { host?: string; source: LogSource; minutes: number }, fetchFn: typeof fetch = fetch): Promise<LogLine[]> {
  if (!SOURCES.includes(q.source)) throw new Error("unknown log source");
  const query = `{${SEL}, source="${q.source}"${q.host ? `, host=${JSON.stringify(q.host)}` : ""}}`;
  const endMs = Date.now();
  const ns = (ms: number) => `${BigInt(ms) * 1_000_000n}`;
  type Streams = { result: { stream: Record<string, string>; values: [string, string][] }[] };
  const data = await grafana<Streams>(process.env.LOKI_UID, "/loki/api/v1/query_range", { query, start: ns(endMs - q.minutes * 60_000), end: ns(endMs), limit: String(LIMIT), direction: "backward" }, fetchFn);
  return data.result
    .flatMap((s) => s.values.map(([t, line]) => ({ t: BigInt(t), host: s.stream.host ?? "", line })))
    .sort((a, b) => (b.t > a.t ? 1 : b.t < a.t ? -1 : 0))
    .slice(0, LIMIT)
    .map(({ t, host, line }) => ({ at: new Date(Number(t / 1_000_000n)).toISOString(), host, line }));
}

// Used percent of the root disk and of memory, per runner host.
export async function hostStats(fetchFn: typeof fetch = fetch): Promise<HostStat[]> {
  type Vector = { result: { metric: Record<string, string>; value: [number, string] }[] };
  const ask = (query: string) => grafana<Vector>(process.env.METRICS_UID, "/api/v1/query", { query }, fetchFn);
  const root = `${SEL}, mountpoint="/"`;
  const [disk, mem] = await Promise.all([
    ask(`100 * (1 - node_filesystem_avail_bytes{${root}} / node_filesystem_size_bytes{${root}})`),
    ask(`100 * (1 - node_memory_MemAvailable_bytes{${SEL}} / node_memory_MemTotal_bytes{${SEL}})`),
  ]);
  const memBy = new Map(mem.result.map((r) => [r.metric.host, Number(r.value[1])]));
  return disk.result.map((r) => ({ host: r.metric.host ?? "", diskUsedPct: Number(r.value[1]), memUsedPct: memBy.get(r.metric.host) ?? Number.NaN }));
}
