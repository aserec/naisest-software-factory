import { expect, test } from "vitest";
import { GitLab, refuseSecrets } from "./gitlab";

const reply = (body: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(body), { status, headers });

test("a request names the base URL, sends the token as a header and parses the JSON", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const fetchFn = (async (url: string, init: RequestInit) => ((seen = { url, init }), reply({ id: 9 }))) as unknown as typeof fetch;
  expect(await new GitLab("https://gl.example", "tok", fetchFn).getJson("/user")).toEqual({ id: 9 });
  expect(seen?.url).toBe("https://gl.example/api/v4/user");
  expect((seen?.init.headers as Record<string, string>)["PRIVATE-TOKEN"]).toBe("tok");
});
test("a failed call names the status and endpoint but not the token", async () => {
  const gl = new GitLab("https://gl.example", "tok", (async () => reply({}, 500)) as unknown as typeof fetch);
  const err = (await gl.getJson("/projects/a%2Fb").catch((e) => e)) as Error;
  expect(err.message).toContain("500");
  expect(err.message).toContain("/projects/a%2Fb");
  expect(err.message).not.toContain("tok");
});
test("a GET retries a 502 and a network error; a write does not retry a network error", async () => {
  const slept: number[] = [];
  const replies: (number | Error)[] = [502, new TypeError("fetch failed"), 200, new TypeError("fetch failed")];
  const fetchFn = (async () => {
    const r = replies.shift()!;
    if (r instanceof Error) throw r;
    return reply({ id: 9 }, r);
  }) as unknown as typeof fetch;
  const g = new GitLab("https://gl.example", "tok", fetchFn, async (ms) => void slept.push(ms));
  expect(await g.getJson("/user")).toEqual({ id: 9 });
  expect(slept).toEqual([1000, 2000]);
  await expect(g.call("PUT", "/projects/1/issues/8", { state_event: "reopen" })).rejects.toThrow("fetch failed");
  expect(replies).toHaveLength(0);
});
test("any method retries a 503, a GET also a 504, and a 500 is not retried", async () => {
  const run = async (method: string, status: number) => {
    let n = 0;
    const g = new GitLab("https://gl.example", "tok", (async () => (++n, reply({}, status))) as unknown as typeof fetch, async () => {});
    await g.call(method, "/x").catch(() => {});
    return n;
  };
  expect(await run("POST", 503)).toBe(3);
  expect(await run("GET", 504)).toBe(3);
  expect(await run("POST", 504)).toBe(1);
  expect(await run("GET", 500)).toBe(1);
});
test("all reads every page of a list", async () => {
  const pages: Record<string, unknown[]> = { "1": [1, 2], "2": [3] };
  const urls: string[] = [];
  const fetchFn = (async (url: string) => {
    urls.push(url);
    const page = new URL(url).searchParams.get("page") ?? "1";
    return reply(pages[page], 200, { "X-Next-Page": page === "1" ? "2" : "" });
  }) as unknown as typeof fetch;
  expect(await new GitLab("https://gl.example", "tok", fetchFn).all("/things?per_page=100")).toEqual([1, 2, 3]);
  expect(urls).toHaveLength(2);
});
test("refuseSecrets throws for a text with a secret and names what was refused", () => {
  expect(() => refuseSecrets("token glpat-abcdefghijklmnopqrst", "Comment")).toThrow("Comment refused: it contains a secret");
  expect(() => refuseSecrets("a plain text", "Comment")).not.toThrow();
});
