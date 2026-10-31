import { z } from "zod";

export const PROOF_DIR = "run/proof/";
export const PROOF_FILE = "run/proof/proof.json";

export interface ProofRun { exit: number; tail: string }
export interface ProofTest { name: string; command: string; before: ProofRun; after: ProofRun }
export interface ProofScreen { name: string; reach: string; width: number; isNew: boolean; before?: string; after?: string } // image names inside run/proof/
export interface Proof { visual: boolean; screens: ProofScreen[]; tests: ProofTest[]; note?: string } // visual: the agent expects the change to look different

const oneLine = z.string().transform((s) => s.replace(/\s+/g, " ").trim());
// No slash, so the file sits directly in run/proof/.
const image = z.string().regex(/^[a-z0-9][a-z0-9-]{0,60}\.png$/);
const run = z.object({ exit: z.number().int(), tail: z.string().transform((s) => s.slice(-1000)) });

const proofSchema = z.object({
  visual: z.boolean(),
  screens: z.array(z.object({
    name: oneLine,
    reach: oneLine,
    width: z.number().int().positive(),
    isNew: z.boolean().default(false),
    before: image.optional(),
    after: image.optional(),
  })).max(5).default([]),
  tests: z.array(z.object({ name: oneLine, command: oneLine, before: run, after: run })).max(20).default([]),
  note: oneLine.optional(),
});

export function parseProof(text: string | undefined): { proof?: Proof; error?: string } {
  if (text === undefined) return { error: "no run/proof/proof.json" };
  if (text.length > 200_000) return { error: "run/proof/proof.json is over 200000 chars" };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { error: "run/proof/proof.json is not JSON" };
  }
  const r = proofSchema.safeParse(json);
  if (!r.success) return { error: `run/proof/proof.json: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` };
  return { proof: r.data };
}

export function readProof(readFile: (path: string) => string | undefined): { proof?: Proof; error?: string; raw?: string } {
  let raw: string | undefined;
  try {
    raw = readFile(PROOF_FILE);
  } catch {
    return { error: "run/proof/proof.json is a link or leaves the clone" };
  }
  return { ...parseProof(raw), raw };
}
