import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Effort } from "software-factory/model-picks";

type Role = { provider: string; model: string; effort?: Effort };
export type ModelOption = { model: string; effort: Effort; models: Record<string, string> };

// The router's choice for each role and the models its provider lists (model id -> family), for the Settings page.
// Not the factory's loadRouter: that imports every harness adapter. The paths work like chatModel's (chat-model.ts).
// ponytail: shows the low row only; both rows pick the same models today. Show both when they differ.
export function modelOptions(router = process.env.ROUTER_FILE ?? "../router.yml", seams = process.env.SEAMS_FILE ?? "../seams.yml"): Record<"author" | "reviewer", ModelOption> {
  const { low } = parse(readFileSync(router, "utf8")) as { low: Record<"author" | "reviewer", Role> };
  const { providers } = parse(readFileSync(seams, "utf8")) as { providers: Record<string, { models: Record<string, string> }> };
  const option = (r: Role): ModelOption => ({ model: r.model, effort: r.effort ?? "medium", models: providers[r.provider].models });
  return { author: option(low.author), reviewer: option(low.reviewer) };
}
