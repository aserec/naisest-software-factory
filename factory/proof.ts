import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FactoryCommands } from "./types";
import type { Finding } from "./agents";
import type { Repo } from "./seams";
import { shellQuote } from "./repo";

export const PROOF_DIR = "run/proof/";
export const PROOF_FILE = "run/proof/proof.json";

export interface ProofRun { exit: number; tail: string }
export interface ProofTest { name: string; command: string; before: ProofRun; after: ProofRun }
export interface ProofScreen { name: string; reach: string; width: number; isNew: boolean; before?: string; after?: string } // image names inside run/proof/
export interface ProofVideo { name: string; file: string } // an e2e test's recording, run/proof/<file>.webm
export interface Proof { visual: boolean; screens: ProofScreen[]; tests: ProofTest[]; video?: ProofVideo; note?: string } // visual: the agent expects the change to look different

const oneLine = z.string().transform((s) => s.replace(/\s+/g, " ").trim());
// No slash, so the file sits directly in run/proof/.
const image = z.string().regex(/^[a-z0-9][a-z0-9-]{0,60}\.png$/);
const webm = z.string().regex(/^[a-z0-9][a-z0-9-]{0,60}\.webm$/);
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
  // Authors of a change with no UI write "video": null; it means no video, not a broken proof.
  video: z.object({ name: oneLine, file: webm }).nullish().transform((v) => v ?? undefined),
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

export const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
const WEBM_SIGNATURE = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

// The manifest's video, when it is a real WebM file. It goes to the change description, never to a model.
export function readVideo(readBytes: Repo["readBytes"], proof: Proof | undefined): Record<string, Buffer> {
  const name = proof?.video?.file;
  const bytes = name && readBytes(PROOF_DIR + name, MAX_VIDEO_BYTES);
  return name && bytes && bytes.subarray(0, 4).equals(WEBM_SIGNATURE) ? { [name]: bytes } : {};
}

// The frames record.sh cut from the video, in time order: <video>-01.png to <video>-08.png. They go to the reviewer, never to the change.
export const MAX_FRAMES = 8;
export const videoFrames = (proof: Proof | undefined): string[] =>
  proof?.video ? Array.from({ length: MAX_FRAMES }, (_, i) => `${proof.video!.file.slice(0, -".webm".length)}-${String(i + 1).padStart(2, "0")}.png`) : [];

export function readFrames(readBytes: Repo["readBytes"], proof: Proof | undefined): Record<string, Buffer> {
  const frames: Record<string, Buffer> = {};
  for (const name of videoFrames(proof)) {
    const bytes = readBytes(PROOF_DIR + name, MAX_IMAGE_BYTES);
    if (bytes && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) frames[name] = bytes;
  }
  return frames;
}

export function proofPrompt(r: { proof?: Proof; error?: string }, attached: string[]): string {
  if (!r.proof) return `No valid proof: ${r.error}`;
  const frames = videoFrames(r.proof).filter((f) => attached.includes(f));
  const video = r.proof.video ? `\n${frames.length ? `Frames of the video ${r.proof.video.file}, in time order: ${frames.join(", ")}` : `No frames of the video ${r.proof.video.file} are attached.`}` : "";
  return `${JSON.stringify(r.proof, null, 2)}\n${attached.length ? `Images, in the order attached: ${attached.join(", ")}` : "No images are attached."}${video}`;
}

// One verdict per screen, and one for the video under its file name. A verdict is "matches" only when the reviewer said so
// and read the images that judge it. Every other case is "unsure".
export function screenVerdicts(findings: Finding[], proof: Proof | undefined, loaded: string[], readsImages: boolean): ScreenVerdict[] {
  // missing: why the images cannot judge this item, or undefined when they can.
  const judge = (screen: string, missing: string | undefined): ScreenVerdict => {
    const unsure = (note: string): ScreenVerdict => ({ screen, verdict: "unsure", note });
    if (!readsImages) return unsure("the reviewer cannot read images");
    const mine = findings.filter((f) => f.screen === screen);
    const f = mine.find((x) => x.verdict !== "matches") ?? mine[0]; // two answers for one screen: the one that is not "matches" counts
    if (!f) return unsure("the reviewer gave no verdict");
    if (!isVerdict(f.verdict)) return unsure(`the reviewer gave an unknown verdict: ${f.verdict}`);
    if (missing) return unsure(missing);
    return { screen, verdict: f.verdict, note: f.text };
  };
  const screens = (proof?.screens ?? []).map((s) =>
    judge(s.name, !s.after || !loaded.includes(s.after) ? "no after image" : !s.isNew && (!s.before || !loaded.includes(s.before)) ? "no before image" : undefined));
  const video = proof?.video ? [judge(proof.video.file, videoFrames(proof).some((f) => loaded.includes(f)) ? undefined : "no frames of the video")] : [];
  const whole = findings.filter((f) => !f.screen && (f.verdict === "unsure" || f.verdict === "does_not_match")).map((f): ScreenVerdict => ({ verdict: "unsure", note: f.text }));
  return [...screens, ...video, ...whole];
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
  const vv = proof.video && r.verdicts.find((x) => x.screen === proof.video!.file);
  const video = proof.video && [
    `### Video: ${vv?.verdict ?? "unsure"}`,
    links[proof.video.file] ? `[Video of the e2e test: ${text(proof.video.name)}](${links[proof.video.file]})` : failed.includes(proof.video.file) ? "video upload failed" : "no video",
    ...(vv?.note ? [`Reviewer: ${text(vv.note)}`] : []),
  ].join("\n\n");
  const tests = proof.tests.map((t) => `- ${text(t.name)}: ${t.before.exit !== 0 ? "failed" : "passed"} before, ${t.after.exit === 0 ? "passes" : "fails"} after`);
  return [
    "## Proof",
    ...screens,
    ...(!screens.length && proof.note ? [`No screenshots: ${text(proof.note)}`] : []),
    ...(video ? [video] : []),
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
  if (hasPreview && proof.visual && !proof.video) reasons.push(`a visual change was expected but there is no video of an e2e test: ${proof.note ?? "no reason given"}`);
  const cannotRead = proof.screens.length > 0 && !r.readsImages;
  if (cannotRead) reasons.push(`the reviewer ${r.reviewer} cannot read images, so no screen was judged`);
  // With a blind reviewer the per-screen lines say nothing new; a whole-proof unsure still counts.
  for (const v of r.verdicts) {
    if (v.verdict === "matches" || (v.screen && cannotRead)) continue;
    const said = v.verdict === "unsure" ? "is unsure" : "says it does not match";
    const what = !v.screen ? "" : v.screen === proof.video?.file ? `video ${v.screen}: ` : `screen ${v.screen}: `;
    reasons.push(`${what}the reviewer ${said}: ${text(v.note)}`);
  }
  const provenTests = testOnly ? proof.tests.length > 0 && proof.tests.every((t) => t.after.exit === 0) : proof.tests.some((t) => t.before.exit !== 0 && t.after.exit === 0);
  if ((!hasPreview || !proof.visual) && !provenTests) reasons.push(testOnly ? "the change touches only tests, but no test passed after it" : "no test failed before the change and passed after it");
  // prepare.md: every behavior the ticket asks for gets a test; screens alone are proof only when the note says why no test can see it.
  else if (proof.tests.length === 0 && !proof.note) reasons.push("the proof has no tests and its note gives no reason");
  if (uploadFailed.length) reasons.push(`image upload failed: ${uploadFailed.join(", ")}`);
  return reasons;
}

// run/shoot.sh: start the preview, wait for the page, shoot it, stop the preview, in one command the author may run.
// A chained one-liner needs curl, kill and the rest allowed one by one, and curl is denied.
// user: shoot logged in. The target's login command (seeded users) writes run/auth-<user>.json; without one the agent writes it.
export function writeShooter(dir: string, c?: Pick<FactoryCommands, "preview" | "login"> & Partial<Pick<FactoryCommands, "test">>) {
  if (!c?.preview) return;
  mkdirSync(join(dir, "run"), { recursive: true });
  writeFileSync(join(dir, "run/shoot.sh"), `# Usage: bash run/shoot.sh <url> <name> [width] [playwright dir] [user]. Writes run/proof/<name>.png.
set -u
url=$1 name=$2 width=\${3:-1280} dir=\${4:-.} user=\${5:-} root=$PWD
case $name in *[!a-z0-9-]*|"") echo "the name takes lowercase letters, digits and dashes only"; exit 2 ;; esac
case $user in *[!a-z0-9-]*) echo "the user takes lowercase letters, digits and dashes only"; exit 2 ;; esac
storage=()
set -m
(${c.preview}) > run/preview.log 2>&1 &
pid=$!
for i in $(seq 120); do curl -sf -o /dev/null "$url" && break; sleep 1; done
code=0
if [ -n "$user" ]; then
  auth="$root/run/auth-$user.json"
${c.login ? `  FACTORY_USER=$user FACTORY_URL=$url FACTORY_STORAGE=$auth bash -c ${shellQuote(c.login)} > run/login.log 2>&1 || { echo "the login failed; the end of run/login.log:"; tail -20 run/login.log; code=1; }\n` : ""}  [ $code = 0 ] && [ ! -s "$auth" ] && { echo "no session for $user: write a Playwright storage state to run/auth-$user.json"; code=1; }
  storage=(--load-storage "$auth")
fi
[ $code = 0 ] && (cd "$dir" && ./node_modules/.bin/playwright screenshot \${storage[@]+"\${storage[@]}"} --viewport-size "$width, 800" --wait-for-timeout 3000 "$url" "$root/run/proof/$name.png")
code=$((code || $?))
kill -- -$pid 2>/dev/null
[ $code = 0 ] || { echo "the shot failed; the end of run/preview.log:"; tail -20 run/preview.log; }
exit $code
`);
  // The test command's env, such as PLAYWRIGHT_PORT: the author may run "bash run/record.sh" with no prefix.
  const env = (c.test?.match(/\b[A-Z_][A-Z0-9_]*=[^\s;&|]+/g) ?? []).map((a) => `export ${a.split("=")[0]}=${shellQuote(a.slice(a.indexOf("=") + 1))}`).join("\n");
  writeFileSync(join(dir, "run/record.sh"), `# Usage: bash run/record.sh <test file[:line]> <name> [playwright dir]. Runs that e2e test with video on, writes run/proof/<name>.webm.
set -u
spec=$1 name=$2 dir=\${3:-.} root=$PWD out=$PWD/run/video-out
case $name in *[!a-z0-9-]*|"") echo "the name takes lowercase letters, digits and dashes only"; exit 2 ;; esac
case $spec in *..*|-*|*[!A-Za-z0-9_./:-]*|"") echo "the test takes a file path, with :line for one test"; exit 2 ;; esac
${env}
cd "$dir" || exit 2
base=$(ls playwright.config.ts playwright.config.mts playwright.config.js playwright.config.mjs 2>/dev/null | head -1)
[ -n "$base" ] || { echo "no playwright.config in $dir"; exit 2; }
# Next to the target's config, so testDir and webServer resolve as they do there. Removed on exit: it must not reach the diff.
cfg=playwright.factory-video.config.ts
trap 'rm -f "$cfg"' EXIT
cat > "$cfg" <<CFG
import base from "./\${base%.*}";
const video = (u: object = {}) => ({ ...u, video: "on" as const });
export default { ...base, outputDir: "$out", use: video(base.use), ...(base.projects && { projects: base.projects.map((p) => ({ ...p, use: video(p.use) })) }) };
CFG
rm -rf "$out"
./node_modules/.bin/playwright test --config "$cfg" --workers=1 --retries=0 "$spec"
code=$?
video=$(find "$out" -name '*.webm' 2>/dev/null | head -1)
[ -n "$video" ] || { echo "the test wrote no video"; exit 1; }
cp "$video" "$root/run/proof/$name.webm"
# Up to ${MAX_FRAMES} frames spread over the video, for the reviewer: run/proof/$name-01.png and on. Playwright's own ffmpeg cuts them.
rm -f "$root/run/proof/$name"-[0-9][0-9].png
# Newest first: an older ffmpeg build cannot decode the VP9 that newer Playwright records.
frames=$out/frames cut=
for f in $(ls -dr "\${PLAYWRIGHT_BROWSERS_PATH:-/nonexistent}"/ffmpeg-*/ffmpeg-* "$HOME"/Library/Caches/ms-playwright/ffmpeg-*/ffmpeg-* "$HOME"/.cache/ms-playwright/ffmpeg-*/ffmpeg-* 2>/dev/null); do
  rm -rf "$frames" && mkdir -p "$frames" && [ -x "$f" ] && "$f" -loglevel error -i "$root/run/proof/$name.webm" -r 1 "$frames/%03d.png" 2>/dev/null && [ -n "$(ls "$frames")" ] && { cut=1; break; }
done
if [ -n "$cut" ]; then
  n=$(ls "$frames" | wc -l) k=$(( n < ${MAX_FRAMES} ? n : ${MAX_FRAMES} ))
  for j in $(seq 0 $((k - 1))); do
    cp "$frames/$(printf %03d $(( k > 1 ? 1 + j * (n - 1) / (k - 1) : 1 ))).png" "$root/run/proof/$name-$(printf %02d $((j + 1))).png"
  done
  echo "wrote $k frames of the video for the reviewer"
else
  echo "could not cut frames from the video, so the reviewer cannot judge it: no Playwright ffmpeg found, or it failed"
fi
exit $code
`);
}
