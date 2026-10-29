import { describe, expect, test } from "vitest";
import type { Judge, JevQuestion } from "../seams";

const QUESTIONS: JevQuestion[] = [
  { id: "a", kind: "noul", text: "Is the sky blue?" },
  { id: "b", kind: "choice", text: "Pick one.", options: ["red", "green", "blue"] },
  { id: "c", kind: "score", text: "Rate it.", levels: 5, min: 2 },
];

// Every Judge must pass this: the fake on every push, the real adapter in the manual job.
export function judgeContract(make: () => Judge) {
  describe("judge contract", () => {
    test("answers come back in question order with the same ids", async () => {
      const answers = await make().ask({}, QUESTIONS);
      expect(answers.map((a) => a.id)).toEqual(["a", "b", "c"]);
    });

    test("a noul answer is true when its probability is 0.5 or more", async () => {
      const [a] = await make().ask({}, QUESTIONS);
      expect(a.value).toBe(a.probability >= 0.5);
    });

    test("a choice answer is one of the options", async () => {
      const [, b] = await make().ask({}, QUESTIONS);
      expect(["red", "green", "blue"]).toContain(b.value);
    });

    test("a score answer is a whole number inside the range", async () => {
      const [, , c] = await make().ask({}, QUESTIONS);
      expect(Number.isInteger(c.value)).toBe(true);
      expect(c.value as number).toBeGreaterThanOrEqual(2);
      expect(c.value as number).toBeLessThanOrEqual(6);
    });

    test("confidence is between 0 and 1", async () => {
      for (const a of await make().ask({}, QUESTIONS)) {
        expect(a.confidence).toBeGreaterThanOrEqual(0);
        expect(a.confidence).toBeLessThanOrEqual(1);
      }
    });
  });
}
