import { expect, test } from "vitest";
import type { JevClient } from "../jev";
import { csvField, shadowRow, main } from "./jev-shadow";

const answers = { injection: 0.05, type: "bug", risk: "low", clarity: 8, effort: 4 };
const fakeJev: JevClient = {
  provider: "berget",
  async ask(_s, qs) {
    return qs.map((q) => ({ id: q.id, value: (answers as any)[q.id], probability: q.id === "injection" ? 0.05 : 0.9, confidence: 0.8 }));
  },
};

test("a row has the ticket, title, five answers with confidence, and the outcome", async () => {
  expect(await shadowRow(fakeJev, { ref: "7", title: "Fix button", body: "d", tags: [] })).toBe("7,Fix button,0.05,bug,0.8,low,0.8,8,0.8,4,0.8,build (low)");
});
test("titles with commas, quotes and line breaks are quoted", async () => {
  expect(csvField('He said "hi", ok')).toBe('"He said ""hi"", ok"');
  expect(csvField("a\nb")).toBe('"a\nb"');
  expect(await shadowRow(fakeJev, { ref: "1", title: 'a, "b"', body: "", tags: [] })).toMatch(/^1,"a, ""b""",/);
});
test("the shadow test refuses the mock provider", async () => {
  await expect(main({ FACTORY_GITLAB_TOKEN: "t" }, ["react_frontend", "5"])).rejects.toThrow(/BERGET_API_KEY/);
});
test("a field that starts with a formula character gets a quote prefix", () => {
  expect(csvField("=SUM(A1)")).toBe("'=SUM(A1)");
  expect(csvField("-1 day")).toBe("'-1 day");
  expect(csvField(-3)).toBe("-3");
});
