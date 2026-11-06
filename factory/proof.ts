import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FactoryCommands } from "./types";
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
}).superRefine((p, ctx) => {
  // Verdicts are matched by screen name, and a reused file could stand for both before and after.
  const names = p.screens.map((s) => s.name);
  if (new Set(names).size !== names.length) ctx.addIssue({ code: "custom", message: "screen names must be unique" });
  const files = p.screens.flatMap((s) => [s.before, s.after]).filter((f): f is string => !!f);
  if (new Set(files).size !== files.length) ctx.addIssue({ code: "custom", message: "each image file must be used once" });
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

const VERDICTS = ["matches", "does_not_match", "unsure"] as const;
export type Verdict = (typeof VERDICTS)[number];
const isVerdict = (v: unknown): v is Verdict => (VERDICTS as readonly unknown[]).includes(v);
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

// One verdict per screen. A screen is "matches" only when the reviewer said so and read the images that judge it. Every other case is "unsure".
export function screenVerdicts(findings: Finding[], proof: Proof | undefined, loaded: string[], readsImages: boolean): ScreenVerdict[] {
  const screens = (proof?.screens ?? []).map((s): ScreenVerdict => {
    const unsure = (note: string): ScreenVerdict => ({ screen: s.name, verdict: "unsure", note });
    if (!readsImages) return unsure("the reviewer cannot read images");
    const mine = findings.filter((f) => f.screen === s.name);
    const f = mine.find((x) => x.verdict !== "matches") ?? mine[0]; // two answers for one screen: the one that is not "matches" counts
    if (!f) return unsure("the reviewer gave no verdict");
    if (!isVerdict(f.verdict)) return unsure(`the reviewer gave an unknown verdict: ${f.verdict}`);
    if (!s.after || !loaded.includes(s.after)) return unsure("no after image");
    if (!s.isNew && (!s.before || !loaded.includes(s.before))) return unsure("no before image");
    return { screen: s.name, verdict: f.verdict, note: f.text };
  });
  const whole = findings.filter((f) => !f.screen && (f.verdict === "unsure" || f.verdict === "does_not_match")).map((f): ScreenVerdict => ({ verdict: "unsure", note: f.text }));
  return [...screens, ...whole];
}

// Agent and reviewer text in the change description: one line, no table break, no HTML, at most 200 chars.
const text = (s: string) => s.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|").replace(/</g, "&lt;").replace(/>/g, "&gt;").slice(0, 200);

// The "Proof" section of the change description. links: image name to the link attach gave. failed: images whose upload failed.
// ponytail: the manifest's reach is never shown or linked: it is free text from the agent.
export function proofSection(r: ProofRecord | undefined, links: Record<string, string>, failed: string[] = []): string {
  const proof = r?.proof;
  if (!proof) return `## Proof\n\nNo proof: ${text(r?.error ?? "code review saved no proof")}`;
  const cell = (alt: string, name?: string) => (name && links[name] ? `![${alt}](${links[name]})` : name && failed.includes(name) ? "image upload failed" : "no image");
  const screens = proof.screens.map((s, i) => {
    const v = r.verdicts.find((x) => x.screen === s.name);
    const table = s.isNew ? ["| After |", "| --- |", `| ${cell("after", s.after)} |`] : ["| Before | After |", "| --- | --- |", `| ${cell("before", s.before)} | ${cell("after", s.after)} |`];
    return [`### Screen ${i + 1}: ${text(s.name)}, ${s.width} px${s.isNew ? ", new screen" : ""}: ${v?.verdict ?? "unsure"}`, ...table, ...(v?.note ? ["", `Reviewer: ${text(v.note)}`] : [])].join("\n");
  });
  const tests = proof.tests.map((t) => `- ${text(t.name)}: ${t.before.exit !== 0 ? "failed" : "passed"} before, ${t.after.exit === 0 ? "passes" : "fails"} after`);
  return [
    "## Proof",
    ...screens,
    ...(!screens.length && proof.note ? [`No screenshots: ${text(proof.note)}`] : []),
    `### Tests\n${tests.length ? tests.join("\n") : "No test proof."}`,
  ].join("\n\n");
}

// Why a change has no proof a person can trust. Empty means the proof is enough.
// testOnly: the diff changes test files only, so its tests pass before too; new tests that pass after are the proof.
export function proofReasons(r: ProofRecord | undefined, hasPreview: boolean, uploadFailed: string[] = [], testOnly = false): string[] {
  const proof = r?.proof;
  if (!r || !proof) return [`no proof: ${r?.error ?? "code review saved no proof"}`];
  const reasons: string[] = [];
  if (hasPreview && proof.visual && proof.screens.length === 0) reasons.push(`a visual change was expected but there are no screenshots: ${proof.note ?? "no reason given"}`);
  const cannotRead = proof.screens.length > 0 && !r.readsImages;
  if (cannotRead) reasons.push(`the reviewer ${r.reviewer} cannot read images, so no screen was judged`);
  // With a blind reviewer the per-screen lines say nothing new; a whole-proof unsure still counts.
  for (const v of r.verdicts) {
    if (v.verdict === "matches" || (v.screen && cannotRead)) continue;
    const said = v.verdict === "unsure" ? "is unsure" : "says it does not match";
    reasons.push(`${v.screen ? `screen ${v.screen}: ` : ""}the reviewer ${said}: ${text(v.note)}`);
  }
  const provenTests = testOnly ? proof.tests.length > 0 && proof.tests.every((t) => t.after.exit === 0) : proof.tests.some((t) => t.before.exit !== 0 && t.after.exit === 0);
  if ((!hasPreview || !proof.visual) && !provenTests) reasons.push(testOnly ? "the change touches only tests, but no test passed after it" : "no test failed before the change and passed after it");
  if (uploadFailed.length) reasons.push(`image upload failed: ${uploadFailed.join(", ")}`);
  return reasons;
}

// run/shoot.sh: start the preview, wait for the page, shoot it, stop the preview, in one command the author may run.
// A chained one-liner needs curl, kill and the rest allowed one by one, and curl is denied.
export function writeShooter(dir: string, c?: Pick<FactoryCommands, "preview">) {
  if (!c?.preview) return;
  mkdirSync(join(dir, "run"), { recursive: true });
  writeFileSync(join(dir, "run/shoot.sh"), `# Usage: bash run/shoot.sh <url> <name> [width] [playwright dir]. Writes run/proof/<name>.png.
set -u
url=$1 name=$2 width=\${3:-1280} dir=\${4:-.} root=$PWD
case $name in *[!a-z0-9-]*|"") echo "the name takes lowercase letters, digits and dashes only"; exit 2 ;; esac
set -m
(${c.preview}) > run/preview.log 2>&1 &
pid=$!
for i in $(seq 120); do curl -sf -o /dev/null "$url" && break; sleep 1; done
(cd "$dir" && ./node_modules/.bin/playwright screenshot --viewport-size "$width, 800" --wait-for-timeout 3000 "$url" "$root/run/proof/$name.png")
code=$?
kill -- -$pid 2>/dev/null
[ $code = 0 ] || { echo "the shot failed; the end of run/preview.log:"; tail -20 run/preview.log; }
exit $code
`);
}
