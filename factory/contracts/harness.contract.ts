import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { Harness, HarnessJob, ModelChoice } from "../seams";

// `model` is a model the harness serves; `unserved` is one it does not.
// `author: false` is for a harness that cannot run an author yet (Pi, until Task 7).
export function harnessContract(make: () => Harness, o: { model: ModelChoice; unserved: ModelChoice; author?: boolean }) {
  const job = (over: Partial<HarnessJob> = {}): HarnessJob => ({
    role: "writer", prompt: "Answer with the single word: pong", model: o.model, cwd: mkdtempSync(join(tmpdir(), "contract-harness-")), tools: "none", maxTurns: 3, ...over,
  });

  describe("harness contract", () => {
    test("a writer job answers", async () => {
      const r = await make().run(job());
      expect(r.ok).toBe(true);
      expect(r.text.toLowerCase()).toContain("pong");
    });

    test.skipIf(o.author === false)("an author job gives a session, and a resume of it is accepted", async () => {
      const h = make();
      const first = await h.run(job({ role: "author", tools: "code" }));
      expect(first.session).not.toBe("");
      const again = await h.run(job({ role: "author", tools: "code", resume: first.session }));
      expect(again.ok).toBe(true);
    });

    test("a model that is not served is a failed run, not a throw and not a limit", async () => {
      const r = await make().run(job({ model: o.unserved }));
      expect(r.ok).toBe(false);
      expect(r.limitHit).toBe(false);
    });
  });
}
