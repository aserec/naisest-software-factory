import { setTimeout as wait } from "node:timers/promises";
import { HttpError } from "./errors";
import { findSecrets } from "./rules";

export const GITLAB_URL = "https://gitlab.example.com";

// Refuses text that holds a secret, before any adapter posts it to GitLab. `what` names the text in the error.
export function refuseSecrets(text: string, what: string): void {
  if (findSecrets(text).length > 0) throw new Error(`${what} refused: it contains a secret`);
}

// The transport to one GitLab: auth, retries, paging and errors. Each adapter knows its own endpoints.
export class GitLab {
  constructor(private baseUrl: string, private token: string, private fetchFn: typeof fetch = fetch, private sleep: (ms: number) => Promise<unknown> = wait) {}

  // A failed call names the status and endpoint, never the token.
  // Retries a busy or unreachable GitLab a few times. 429/502/503 mean the request was not handled, so any
  // method retries them. A GET also retries 504, a timeout and network errors; a write there may have
  // gone through already (a second comment or merge), so it fails at once. 500 is a GitLab bug: no retry.
  async call(method: string, endpoint: string, body?: unknown): Promise<Response> {
    const form = body instanceof FormData; // fetch sets the multipart type itself
    const get = method === "GET";
    for (let attempt = 1; ; attempt++) {
      const last = attempt === 3;
      let res: Response;
      try {
        res = await this.fetchFn(`${this.baseUrl}/api/v4${endpoint}`, {
          method,
          headers: form ? { "PRIVATE-TOKEN": this.token } : { "PRIVATE-TOKEN": this.token, "Content-Type": "application/json" },
          body: body === undefined ? undefined : form ? body : JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (e) {
        if (!get || last) throw e;
        await this.sleep(1000 * attempt);
        continue;
      }
      if (res.ok) return res;
      if (last || !([429, 502, 503].includes(res.status) || (get && res.status === 504))) throw new HttpError(`GitLab ${method} ${endpoint} failed with status ${res.status}`, res.status);
      await this.sleep(1000 * attempt);
    }
  }

  // Every page of a list endpoint. The endpoint must already carry per_page=100.
  async all(endpoint: string): Promise<any[]> {
    const out: any[] = [];
    for (let page = 1; page; ) {
      const res = await this.call("GET", `${endpoint}&page=${page}`);
      out.push(...(await res.json()));
      page = Number(res.headers.get("X-Next-Page")) || 0;
    }
    return out;
  }

  // A GET that returns GitLab's own JSON. The adapter maps it to factory words.
  async getJson(endpoint: string) {
    return (await this.call("GET", endpoint)).json();
  }
}
