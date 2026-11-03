export const GITHUB_API = "https://api.github.com";

// A small GitHub REST and GraphQL client. A failed call names the status and endpoint, never the token.
// A GET retries 429/502/503/504 a few times. A write fails at once: it may have gone through already.
export class GitHub {
  constructor(private token: string, private fetchFn: typeof fetch = fetch, private sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))) {}

  async call(method: string, path: string, body?: unknown): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      const res = await this.fetchFn(`${GITHUB_API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) return res;
      if (method !== "GET" || attempt === 3 || ![429, 502, 503, 504].includes(res.status)) throw new Error(`GitHub ${method} ${path.split("?")[0]} failed with status ${res.status}`);
      await this.sleep(1000 * attempt);
    }
  }

  async json(method: string, path: string, body?: unknown) {
    const res = await this.call(method, path, body);
    return res.status === 204 ? undefined : res.json();
  }

  // Every page of a list endpoint, in GitHub's order. The path must already carry per_page=100.
  async all(path: string): Promise<any[]> {
    const out: any[] = [];
    for (let page = 1; ; page++) {
      const items = await this.json("GET", `${path}&page=${page}`);
      out.push(...items);
      if (items.length < 100) return out;
    }
  }

  async graphql(query: string, variables: Record<string, unknown>) {
    const r = await this.json("POST", "/graphql", { query, variables });
    if (r.errors?.length) throw new Error(`GitHub GraphQL failed: ${String(r.errors[0].message).slice(0, 200)}`);
    return r.data;
  }
}
