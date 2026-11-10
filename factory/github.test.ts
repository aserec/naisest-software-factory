import { expect, test } from "vitest";
import { isNotFound } from "./errors";
import { GitHub } from "./github";

// Each call to fetch returns the next response; the count of calls is what the tests check.
const client = (responses: Response[]) => {
  let n = 0;
  const fetchFn = (async () => responses[n++].clone()) as unknown as typeof fetch;
  return { gh: new GitHub("tok", fetchFn, async () => {}), calls: () => n };
};
const wentWrong = Response.json({ errors: [{ message: "Something went wrong while executing your query on 2026-11-05T16:14:46Z." }] });
const ok = Response.json({ data: { viewer: { login: "bot" } } });

test("a rate-limited call of any method waits for the reset and goes again; a 403 that is no rate limit fails at once", async () => {
  const waits: number[] = [];
  const limited = () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60) } });
  const responses = [limited(), new Response(null, { status: 204 })];
  let n = 0;
  const gh = new GitHub("tok", (async () => responses[n++]) as unknown as typeof fetch, async (ms) => void waits.push(ms));
  await gh.call("DELETE", "/repos/o/r/issues/1/labels/x");
  expect(n).toBe(2);
  expect(waits[0]).toBeGreaterThan(55_000);
  const denied = client([new Response("{}", { status: 403 })]);
  await expect(denied.gh.call("DELETE", "/repos/o/r/issues/1/labels/x")).rejects.toThrow("status 403");
  expect(denied.calls()).toBe(1);
  const always = client(Array(4).fill(new Response("{}", { status: 429, headers: { "retry-after": "1" } })));
  await expect(always.gh.call("POST", "/repos/o/r/issues")).rejects.toThrow("status 429");
  expect(always.calls()).toBe(3);
});

test("a spent GraphQL budget, a 200 with a RATE_LIMIT error, waits for the reset and goes again", async () => {
  const waits: number[] = [];
  const spent = Response.json({ errors: [{ type: "RATE_LIMIT", message: "API rate limit already exceeded for user ID 1." }] }, { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60) } });
  const responses = [spent, ok];
  let n = 0;
  const gh = new GitHub("tok", (async () => responses[n++].clone()) as unknown as typeof fetch, async (ms) => void waits.push(ms));
  expect(await gh.graphql("{ viewer { login } }", {})).toEqual({ viewer: { login: "bot" } });
  expect(waits[0]).toBeGreaterThan(55_000);
});

test("graphql tries GitHub's 'Something went wrong' error again and returns the data", async () => {
  const { gh, calls } = client([wentWrong, wentWrong, ok]);
  expect(await gh.graphql("{ viewer { login } }", {})).toEqual({ viewer: { login: "bot" } });
  expect(calls()).toBe(3);
});

test("graphql gives up after 5 tries", async () => {
  const { gh, calls } = client([wentWrong, wentWrong, wentWrong, wentWrong, wentWrong, ok]);
  await expect(gh.graphql("{ viewer { login } }", {})).rejects.toThrow("Something went wrong");
  expect(calls()).toBe(5);
});

test("graphql tries a 502 again, 5 times in all", async () => {
  const { gh, calls } = client([new Response("", { status: 502 }), ok]);
  expect(await gh.graphql("{ viewer { login } }", {})).toEqual({ viewer: { login: "bot" } });
  expect(calls()).toBe(2);
  const down = client(Array(6).fill(new Response("", { status: 502 })));
  await expect(down.gh.graphql("{ viewer { login } }", {})).rejects.toThrow("status 502");
  expect(down.calls()).toBe(5);
});

test("a GraphQL NOT_FOUND is a 404", async () => {
  const { gh } = client([Response.json({ errors: [{ type: "NOT_FOUND", message: "Could not resolve to an Issue with the number of 326." }] })]);
  expect(isNotFound(await gh.graphql("{ viewer { login } }", {}).catch((e) => e))).toBe(true);
});

test("graphql does not try a query error again", async () => {
  const { gh, calls } = client([Response.json({ errors: [{ message: "Could not resolve to a Repository" }] }), ok]);
  await expect(gh.graphql("{ viewer { login } }", {})).rejects.toThrow("Could not resolve");
  expect(calls()).toBe(1);
});

test("a request that never reached GitHub is tried again, for any method; other network errors on a write are not", async () => {
  const down = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: { code } });
  let n = 0;
  const flaky = (async () => (n++ < 2 ? Promise.reject(down("ENOTFOUND")) : Response.json({ id: 1 }))) as unknown as typeof fetch;
  expect(await new GitHub("tok", flaky, async () => {}).json("POST", "/repos/a/b/pulls", {})).toEqual({ id: 1 });
  expect(n).toBe(3);
  let m = 0;
  const reset = (async () => (m++, Promise.reject(down("ECONNRESET")))) as unknown as typeof fetch;
  await expect(new GitHub("tok", reset, async () => {}).json("POST", "/repos/a/b/pulls", {})).rejects.toThrow("fetch failed");
  expect(m).toBe(1);
  let k = 0;
  const gone = (async () => (k++, Promise.reject(down("UND_ERR_CONNECT_TIMEOUT")))) as unknown as typeof fetch;
  await expect(new GitHub("tok", gone, async () => {}).graphql("{ viewer { login } }", {})).rejects.toThrow("fetch failed");
  expect(k).toBe(8);
});
