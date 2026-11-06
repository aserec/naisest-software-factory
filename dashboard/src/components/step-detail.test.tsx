import { cleanup, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { usageByModel } from "./cost-by-model";
import { StepDetail } from "./step-detail";
import { ev, renderWithQuery } from "./test-utils";

// The real api(), watched, so a test can see the job log goes through it (a 401 there sends the user to sign-in).
const api = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (real) => {
  const m = await real<typeof import("@/lib/api")>();
  api.mockImplementation(m.api);
  return { api };
});

afterEach(() => (cleanup(), vi.unstubAllGlobals()));

const start = ev("step_start", "00", { step: "precommit-gate", job: "42", data: { prompt: "Fix the bug" } });
const events = [
  ev("review_finding", "01", { data: { text: "Missing test", blocking: true, round: 1 } }),
  ev("gate_check", "01", { data: { command: "pnpm test", exitCode: 1, outputTail: "1 failed" } }),
  ev("rule_check", "01", { data: { rule: "no-secrets", passed: true, detail: "clean" } }),
  ev("jev_answer", "01", { data: { question: "Which API?", answer: "v2", confidence: "high" } }),
  ev("usage", "02", { data: { costUsd: 0.5 } }),
];

test("an agent step shows the prompt its agent was sent", () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("")));
  renderWithQuery(<StepDetail start={ev("step_start", "00", { step: "code-review" })} events={[ev("prompt", "01", { data: { role: "reviewer", prompt: "Review this diff" } })]} />);
  expect(document.body.textContent).toContain("Review this diff");
});

test("shows everything about the step and asks GitLab for its job log once", async () => {
  const fetchFn = vi.fn(async () => new Response("log line one"));
  vi.stubGlobal("fetch", fetchFn);
  renderWithQuery(<StepDetail start={start} events={events} />);
  expect(await screen.findByText("log line one")).toBeTruthy();
  for (const text of ["Fix the bug", "Missing test", "Blocking", "pnpm test", "exit 1", "no-secrets", "clean", "Which API?", "v2 · high confidence", "$0.50"]) {
    expect(document.body.textContent).toContain(text);
  }
  expect(api).toHaveBeenCalledWith("/api/jobs/42/log");
  expect(fetchFn).toHaveBeenCalledTimes(1);
});

test("a triage outcome url that is not http(s) shows as text, not as a link", () => {
  vi.stubGlobal("fetch", vi.fn());
  const step = ev("step_start", "00", { step: "triage", data: {} });
  const outcome = ev("triage_outcome", "01", { step: "triage", data: { kind: "stop", title: "Stopped", reasons: ["r"], url: "javascript:alert(1)" } });
  renderWithQuery(<StepDetail start={step} events={[outcome]} />);
  expect(screen.queryByRole("link")).toBeNull();
  expect(document.body.textContent).toContain("javascript:alert(1)");
});

test("a step without a CI job shows the log its step_end event sent, and asks nothing", async () => {
  const fetchFn = vi.fn();
  vi.stubGlobal("fetch", fetchFn);
  const local = ev("step_start", "00", { step: "triage", data: {} });
  const end = ev("step_end", "03", { step: "triage", data: { outcome: "next", log: "installed 12 packages" } });
  renderWithQuery(<StepDetail start={local} end={end} events={[]} />);
  expect(await screen.findByText("installed 12 packages")).toBeTruthy();
  expect(fetchFn).not.toHaveBeenCalled();
});

test("groups findings by round, splits the file from the text, and links the file into the change's diff", async () => {
  vi.stubGlobal("fetch", vi.fn());
  const found = [
    ev("review_finding", "01", { data: { text: "src/a.ts: Misses a test", blocking: true, round: 1 } }),
    ev("review_finding", "02", { data: { text: "src/b.ts: Checks the empty name", blocking: false, round: 2, title: "Empty name checked", file: "src/b.ts" } }),
  ];
  renderWithQuery(<StepDetail start={start} events={found} fileLink={{ base: "https://host/change/1/diffs#", hash: "SHA-1" }} />);
  expect(screen.getAllByText(/^Round \d/).map((e) => e.textContent)).toEqual(["Round 1 1 of 1 blocking", "Round 2 0 of 1 blocking"]);
  expect(screen.getByText("Misses a test")).toBeTruthy(); // an older event: the file comes from the text
  expect(screen.getByText("Empty name checked")).toBeTruthy();
  // sha1("src/b.ts")
  const { createHash } = await import("node:crypto");
  expect((await screen.findByRole("link", { name: "src/b.ts" })).getAttribute("href")).toBe(`https://host/change/1/diffs#${createHash("sha1").update("src/b.ts").digest("hex")}`);
  expect(screen.getByRole("link", { name: "src/a.ts" })).toBeTruthy();
});

test("a decision shows its reasons as a list, the merge risk and the change, and keeps the log closed", async () => {
  vi.stubGlobal("fetch", vi.fn());
  const step = ev("step_start", "00", { step: "decision", data: {} });
  const end = ev("step_end", "03", { step: "decision", data: { outcome: "stop", log: "[chat needs_approval] title" } });
  const decision = ev("decision", "01", { step: "decision", data: { auto: false, reasons: ["hard rule size failed: 1538 lines", "no proof: no proof.json"], risk: 6, riskMax: 4, changeUrl: "https://example.com/pull/441" } });
  renderWithQuery(<StepDetail start={step} end={end} events={[decision]} />);
  const items = [...document.querySelectorAll("li")].map((li) => li.textContent);
  expect(items).toEqual(["Hard rule size failed: 1538 lines", "No proof: no proof.json"]);
  expect(document.body.textContent).toContain("6 of 10, the limit is 4");
  expect(screen.getByRole("link", { name: "https://example.com/pull/441" })).toBeTruthy();
  expect(document.querySelector("details")?.open).toBe(false);
  expect(document.body.textContent).toContain("None, no model ran in this step");
});

test("a model with no price shows its cost is missing, not just $0.00", () => {
  vi.stubGlobal("fetch", vi.fn());
  const usage = ev("usage", "02", { data: { model: "glm-flash", input: 900, output: 40, costUsd: 0 } });
  renderWithQuery(<StepDetail start={start} events={[usage]} />);
  expect(document.body.textContent).toContain("Without glm-flash: seams.yml sets no price for it");
});

test("a triage stop shows its final decision first, in its own color, with the reasons and the original", async () => {
  vi.stubGlobal("fetch", vi.fn());
  const step = ev("step_start", "00", { step: "triage", data: {} });
  const outcome = ev("triage_outcome", "01", { step: "triage", data: { kind: "stop", title: "Stopped: a duplicate of #328, so the factory closed it", reasons: ['Jev compared it with #328 "Marcar" and answered "same" with 0.95 confidence.'], url: "https://github.com/o/r/issues/328" } });
  const answer = ev("jev_answer", "01", { step: "triage", data: { question: "Which candidate is closest?", answer: "328", confidence: "0.9" } });
  renderWithQuery(<StepDetail start={step} events={[outcome, answer]} />);
  const box = screen.getByRole("region", { name: "Final decision" });
  expect(box.textContent).toContain("Stop");
  expect(box.textContent).toContain('answered "same" with 0.95 confidence');
  expect(box.className).toContain("bg-pill-negative");
  expect(screen.getByRole("link", { name: "https://github.com/o/r/issues/328" })).toBeTruthy();
  // The decision comes before the step facts and the Jev answers.
  expect(document.body.textContent!.indexOf("Stopped: a duplicate")).toBeLessThan(document.body.textContent!.indexOf("Started"));
});

test("each tool call has its tool's icon, a bash call shows its command in mono and its time, and calls of one tool in a row fold into one line", () => {
  vi.stubGlobal("fetch", vi.fn());
  const call = (name: string, input: unknown, ms = 40, ok = true) => ev("tool_call", "01", { data: { name, input: typeof input === "string" ? input : JSON.stringify(input), result: `${name} result`, ms, ok } });
  const reads = [1, 2, 3].map((n) => call("Read", { file_path: `src/${n}.ts` }, 500, n !== 2));
  const tools = [call("Bash", { command: "pnpm test --run" }, 2500), ...reads, call("Edit", "cut at the limit", NaN)];
  renderWithQuery(<StepDetail start={start} events={[]} tools={tools} />);
  const bash = screen.getByText("pnpm test --run");
  expect(bash.tagName).toBe("CODE");
  expect(bash.className).toContain("font-mono");
  const bashRow = bash.closest("summary")!;
  expect(bashRow.querySelector("svg")!.getAttribute("class")).toContain("lucide-square-terminal");
  expect(bashRow.textContent).toBe("Bashpnpm test --run3 s");
  // Three reads in a row: one line with the count, the summed time and the failures; each call is still inside it, with its full text.
  const fold = screen.getByText("3 calls in a row").closest("details")!;
  expect(fold.querySelector("summary")!.textContent).toBe("Read3 calls in a row2 s, 1 failed");
  expect(fold.querySelector("summary svg")!.getAttribute("class")).toContain("lucide-file-text");
  expect([...fold.querySelectorAll("li summary")].map((s) => s.textContent)).toEqual(["Readsrc/1.ts500 ms", "Readsrc/2.ts500 ms, failed", "Readsrc/3.ts500 ms"]);
  expect(fold.textContent).toContain('{"file_path":"src/2.ts"}');
  expect(fold.textContent).toContain("Read result");
  // An input that is not JSON shows no target, and a call with no time shows none.
  const edit = screen.getByText("Edit").closest("summary")!;
  expect(edit.textContent).toBe("Edit");
  expect(edit.querySelector("svg")!.getAttribute("class")).toContain("lucide-file-pen");
});

test("usageByModel sums the usage per role and model and in all, and names the models with no price", () => {
  const u = (role: string, model: string, n: number, costUsd: number) => ({ role, model, input: n, output: n, cacheRead: n, cacheWrite: n, costUsd, contextTokens: 0 });
  const { rows, total, unpriced } = usageByModel([u("author", "opus", 10, 1), u("reviewer", "glm", 5, 0), u("author", "opus", 20, 2)]);
  expect(rows).toEqual([
    { role: "author", model: "opus", input: 30, output: 30, cacheRead: 30, cacheWrite: 30, costUsd: 3 },
    { role: "reviewer", model: "glm", input: 5, output: 5, cacheRead: 5, cacheWrite: 5, costUsd: 0 },
  ]);
  expect(total).toEqual({ input: 35, output: 35, cacheRead: 35, cacheWrite: 35, costUsd: 3 });
  expect(unpriced).toEqual(["glm"]);
});

test("shows the error a failed step sent", async () => {
  renderWithQuery(<StepDetail start={ev("step_start", "00", { step: "triage" })} events={[ev("error", "01", { data: { message: "Jev did not answer" } })]} />);
  expect(screen.getByRole("heading", { name: "Error" })).toBeTruthy();
  expect(screen.getByText("Jev did not answer")).toBeTruthy();
});
