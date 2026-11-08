import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { chatModel } from "./chat-model";

const seams = (yml: string) => {
  const p = join(mkdtempSync(join(tmpdir(), "seams-")), "seams.yml");
  writeFileSync(p, yml);
  return p;
};

it("gives the chat model with its provider", () => {
  const p = seams("chatModel: { provider: tx, model: m1 }\nproviders:\n  tx: { api: openai, baseUrl: https://x/v1, keyEnv: TX_KEY }\n");
  expect(chatModel(p)).toEqual({ provider: { name: "tx", api: "openai", baseUrl: "https://x/v1", keyEnv: "TX_KEY" }, model: "m1" });
});

it("throws when chatModel or its provider is missing", () => {
  expect(() => chatModel(seams("providers: {}\n"))).toThrow("chatModel needs");
  expect(() => chatModel(seams("chatModel: { provider: tx, model: m1 }\nproviders: {}\n"))).toThrow("provider tx");
});
