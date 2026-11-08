import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { callModel } from "software-factory/model-call";

// Not the factory's loadSeams: that imports every harness adapter, too heavy for the Next server.
// The default path is SEAMS_FILE, else ../seams.yml: the dashboard runs from dashboard/, next to the repo's seams.yml.
export function chatModel(path = process.env.SEAMS_FILE ?? "../seams.yml"): Parameters<typeof callModel>[0] {
  const seams = parse(readFileSync(path, "utf8")) as { chatModel?: { provider?: string; model?: string }; providers?: Record<string, object> };
  const { provider, model } = seams.chatModel ?? {};
  if (!provider || !model) throw new Error(`${path}: chatModel needs a provider and a model`);
  const found = seams.providers?.[provider];
  if (!found) throw new Error(`${path}: chatModel provider ${provider} is not in providers`);
  return { provider: { name: provider, ...found }, model } as Parameters<typeof callModel>[0];
}
