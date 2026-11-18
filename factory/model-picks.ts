// A target's Settings page may pick the author's and the reviewer's model and effort. The harness and the provider stay the router row's.
// Light on purpose: the dashboard imports it, and config.ts imports every harness adapter.
export const EFFORTS = ["medium", "high", "xhigh"] as const;
export type Effort = (typeof EFFORTS)[number];
export const PICK_ROLES = ["author", "reviewer"] as const;
type PickRole = (typeof PICK_ROLES)[number];
export interface ModelPick { model: string; effort: Effort }
export type ModelPicks = Partial<Record<PickRole, ModelPick>>;

// The same family may review only at another effort. A missing effort runs as medium (adapters/claude-code.ts).
export function sameFamilyError(families: Record<PickRole, string>, efforts: Record<PickRole, Effort | undefined>): string | undefined {
  const a = efforts.author ?? "medium";
  if (families.author === families.reviewer && a === (efforts.reviewer ?? "medium")) return `author and reviewer are both family ${families.author} at effort ${a}`;
}

// Fails closed like checkThresholds: with any error the row stays the router's. models: each role's provider models, model id -> family.
export function checkModelPicks<T extends { model: string; effort?: Effort }>(raw: unknown, row: Record<PickRole, T>, models: Record<PickRole, Record<string, string>>): { row: Record<PickRole, T>; errors: string[] } {
  if (raw === null || raw === undefined) return { row, errors: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) return { row, errors: ["Settings: models is not a map"] };
  const picked = { ...row };
  const errors = Object.keys(raw).filter((k) => !(PICK_ROLES as readonly string[]).includes(k)).map((k) => `Settings: unknown model role ${k}`);
  for (const role of PICK_ROLES) {
    const p = (raw as Record<string, unknown>)[role] as Partial<ModelPick> | undefined;
    if (p === undefined) continue;
    if (typeof p?.model === "string" && Object.hasOwn(models[role], p.model) && EFFORTS.includes(p.effort as Effort)) picked[role] = { ...row[role], model: p.model, effort: p.effort };
    else errors.push(`Settings: the ${role} must be one of the models ${Object.keys(models[role]).join(", ")} at an effort of ${EFFORTS.join(", ")}`);
  }
  const same = sameFamilyError({ author: models.author[picked.author.model], reviewer: models.reviewer[picked.reviewer.model] }, { author: picked.author.effort, reviewer: picked.reviewer.effort });
  if (same) errors.push(`Settings: ${same}`);
  return errors.length ? { row, errors } : { row: picked, errors };
}
