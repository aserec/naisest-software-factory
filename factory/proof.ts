import { z } from "zod";
import type { Finding } from "./agents";
import type { Repo } from "./seams";

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

export type Verdict = "matches" | "does_not_match" | "unsure";
export interface ScreenVerdict { screen?: string; verdict: Verdict; note: string } // no screen: about the proof as a whole
export interface ProofRecord { proof?: Proof; error?: string; verdicts: ScreenVerdict[]; readsImages: boolean; reviewer: string } // reviewer: "<harness>/<model>"

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The before and after images of the manifest, in its order. Only real PNG files: the agent wrote them, and they go to a model.
export function readImages(readBytes: Repo["readBytes"], proof: Proof | undefined): Record<string, Buffer> {
  const images: Record<string, Buffer> = {};
  for (const s of proof?.screens ?? []) {
    for (const name of [s.before, s.after]) {
      const bytes = name && readBytes(PROOF_DIR + name, MAX_IMAGE_BYTES);
      if (name && bytes && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) images[name] = bytes;
    }
  }
  return images;
}

export function proofPrompt(r: { proof?: Proof; error?: string }, attached: string[]): string {
  if (!r.proof) return `No valid proof: ${r.error}`;
  return `${JSON.stringify(r.proof, null, 2)}\n${attached.length ? `Images, in the order attached: ${attached.join(", ")}` : "No images are attached."}`;
}

const VERDICTS: string[] = ["matches", "does_not_match", "unsure"];

// One verdict per screen. A screen is "matches" only when the reviewer said so and read the images that judge it. Every other case is "unsure".
export function screenVerdicts(findings: Finding[], proof: Proof | undefined, loaded: string[], readsImages: boolean): ScreenVerdict[] {
  const screens = (proof?.screens ?? []).map((s): ScreenVerdict => {
    const unsure = (note: string): ScreenVerdict => ({ screen: s.name, verdict: "unsure", note });
    if (!readsImages) return unsure("the reviewer cannot read images");
    const mine = findings.filter((f) => f.screen === s.name);
    const f = mine.find((x) => x.verdict !== "matches") ?? mine[0]; // two answers for one screen: the one that is not "matches" counts
    if (!f) return unsure("the reviewer gave no verdict");
    if (!f.verdict || !VERDICTS.includes(f.verdict)) return unsure(`the reviewer gave an unknown verdict: ${f.verdict}`);
    if (!s.after || !loaded.includes(s.after)) return unsure("no after image");
    if (!s.isNew && (!s.before || !loaded.includes(s.before))) return unsure("no before image");
    return { screen: s.name, verdict: f.verdict as Verdict, note: f.text };
  });
  const whole = findings.filter((f) => !f.screen && f.verdict === "unsure").map((f): ScreenVerdict => ({ verdict: "unsure", note: f.text }));
  return [...screens, ...whole];
}
