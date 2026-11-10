import { setTimeout as wait } from "node:timers/promises";
import { HttpError } from "./errors";

export const GITHUB_API = "https://api.github.com";

// A small GitHub REST and GraphQL client. A failed call names the status and endpoint, never the token.
// A GET retries 429/502/503/504 a few times. A write fails at once: it may have gone through already.
// A request that never reached GitHub (no DNS, no connection) is tried again for any method, for a few minutes:
// a laptop's Wi-Fi drop must not end a run that took half an hour.
const NOT_SENT = ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"];
const notSent = (e: unknown) => e instanceof TypeError && NOT_SENT.includes((e.cause as { code?: string } | undefined)?.code ?? "");
const GQL_TRIES = 5;
const LIMIT_TRIES = 3;
const MAX_LIMIT_WAIT = 15 * 60_000;
// How long to wait out a rate limit, or undefined for a response that is no rate limit. GitHub refuses a rate-limited
// request without doing it, so any method can go again: ticket 116 lost a passed gate to a 403 on a label delete.
// Secondary limits send retry-after; a spent budget sends remaining 0 and the reset time.
export function rateLimitWait(res: Response, now = Date.now()): number | undefined {
  if (res.status !== 403 && res.status !== 429) return undefined;
  const after = res.headers.get("retry-after");
  if (after) return Number(after) * 1000;
  if (res.headers.get("x-ratelimit-remaining") !== "0") return undefined;
  return Math.max(0, Number(res.headers.get("x-ratelimit-reset")) * 1000 - now) + 1000;
}
const NET_TRIES = 8; // waits 5, 10, ... 35 s between tries: 140 s in all, plus each connect timeout

export class GitHub {
  constructor(private token: string, private fetchFn: typeof fetch = fetch, private sleep: (ms: number) => Promise<unknown> = wait) {}

  // once: GraphQL does its own retries, so a 502 is not tried 3 × 3 times.
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, once = false): Promise<Response> {
    for (let attempt = 1, net = 1, limited = 1; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(`${GITHUB_API}${path}`, {
          method,
          headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json", ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (e) {
        if (!notSent(e) || net === NET_TRIES) throw e;
        await this.sleep(5000 * net++);
        attempt--;
        continue;
      }
      if (res.ok) return res;
      const limit = rateLimitWait(res);
      if (limit !== undefined && limit <= MAX_LIMIT_WAIT && limited++ < LIMIT_TRIES) {
        console.error(`GitHub rate limit on ${method} ${path.split("?")[0]}: trying again in ${Math.ceil(limit / 1000)} s`);
        await this.sleep(limit);
        attempt--;
        continue;
      }
      if (method !== "GET" || once || attempt === 3 || ![429, 502, 503, 504].includes(res.status)) throw new HttpError(`GitHub ${method} ${path.split("?")[0]} failed with status ${res.status}`, res.status);
      await this.sleep(1000 * attempt);
    }
  }

  async json(method: string, path: string, body?: unknown) {
    const res = await this.call(method, path, body);
    return res.status === 204 ? undefined : res.json();
  }

  // The token's own login, asked once.
  private bot?: Promise<string>;
  botName(): Promise<string> {
    return (this.bot ??= this.json("GET", "/user").then((u) => u.login as string));
  }

  // Every page of a list endpoint, in GitHub's order. The path must already carry per_page=100.
  async all<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const items = await this.json("GET", `${path}&page=${page}`);
      out.push(...items);
      if (items.length < 100) return out;
    }
  }

  // GitHub's own failures (a 502/503/504, or "Something went wrong while executing your query") are tried GQL_TRIES times,
  // waiting 2, 4, 8, 16 s: three tries a second apart all failed in one GitHub incident and ended ticket 453's run.
  // That is safe only because every query and mutation the factory sends is a read or can run twice: adding a card
  // that exists returns it, and setting or clearing a field again changes nothing. A new mutation must be too.
  async graphql(query: string, variables: Record<string, unknown>) {
    for (let attempt = 1, limited = 1; ; attempt++) {
      let r, res: Response;
      try {
        res = await this.call("POST", "/graphql", { query, variables }, {}, true);
        r = await res.json();
      } catch (e) {
        if (attempt === GQL_TRIES || !/failed with status (502|503|504)$/.test(String(e))) throw e;
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!r.errors?.length) return r.data;
      const message = String(r.errors[0].message);
      // A missing issue or project: NOT_FOUND, "Could not resolve to an Issue ...". Callers check it as a 404.
      if (r.errors[0].type === "NOT_FOUND" || message.startsWith("Could not resolve to ")) throw new HttpError(`GitHub GraphQL failed: ${message.slice(0, 200)}`, 404);
      // A spent GraphQL budget comes back as status 200 with a RATE_LIMIT error, so call() never waits for it.
      const limit = r.errors[0].type === "RATE_LIMIT" ? rateLimitWait(new Response(null, { status: 429, headers: res.headers })) : undefined;
      if (limit !== undefined && limit <= MAX_LIMIT_WAIT && limited++ < LIMIT_TRIES) {
        console.error(`GitHub GraphQL rate limit: trying again in ${Math.ceil(limit / 1000)} s`);
        await this.sleep(limit);
        attempt--;
        continue;
      }
      if (attempt === GQL_TRIES || !message.startsWith("Something went wrong")) throw new Error(`GitHub GraphQL failed: ${message.slice(0, 200)}`);
      await this.sleep(1000 * 2 ** attempt);
    }
  }
}
