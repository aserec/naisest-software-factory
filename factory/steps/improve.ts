// The weekly improve job: reads a week of corrections people made to the factory in one target, asks the writer for edits
// to the target's .factory/ files, checks them in code, and opens at most one change and one fix for people to read.
// Only a confirmed fix (a pure rename of a path that is gone) merges without a person.
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeContext } from "../compose";
import { collectEvidence } from "../improve/evidence";
import { assertImprovePaths, checkEdits, type Edit, IMPROVE_PATHS, type ImprovePath, improvePrompt, parseProposal } from "../improve/proposal";
import { findSecrets } from "../rules";
import { THRESHOLDS_PATH, readThresholds } from "../thresholds";
import type { ChangeRef } from "../seams";
import { agent, isMain, switchOn, waitFor, type StepContext } from "./context";

// Not factory/<n>-: the merge event, the poller and changeOfTicket never take these for a run.
export const improveBranch = (kind: "change" | "fix", day: string) => `factory-improve/${kind}-${day}`;

const FIX_TITLE = "fix(factory): drop instructions for paths that no longer exist";
type Current = Partial<Record<ImprovePath, string>>;
interface Pushed { ref: ChangeRef; sha: string }

// Writes the edits into the clone, checks what git sees, then pushes and opens the change. Nothing is pushed when a check throws.
async function push(ctx: StepContext, branch: string, title: string, body: string, edits: Edit[]): Promise<Pushed> {
  writeAll(ctx, edits);
  const diff = await ctx.repo.diff();
  assertImprovePaths(diff.numstat);
  if (findSecrets(diff.text + body).length > 0) throw new Error("The improve job found a secret in its change, so it pushed nothing");
  const sha = await ctx.repo.commitAndPush(branch, title);
  const { ref } = await ctx.codeHost.openChange(branch, title, body);
  return { ref, sha };
}

// A target repo may commit .factory, or one file in it, as a link that leads out of the clone. Every path of the set is
// checked before the first one is written, so a link means nothing is written at all.
function writeAll(ctx: StepContext, files: { path: string; text: string }[]): void {
  const root = join(ctx.dir, ".factory");
  const state = lstatOrUndefined(root);
  if (state && !state.isDirectory()) throw new Error("The improve job found .factory is a link or not a folder, so it wrote nothing");
  mkdirSync(root, { recursive: true });
  const real = join(realpathSync(ctx.dir), ".factory");
  for (const { path } of files) {
    const full = join(ctx.dir, path);
    if (realpathSync(dirname(full)) !== real || lstatOrUndefined(full)?.isSymbolicLink()) throw new Error(`The improve job found ${path} is a link out of the clone, so it wrote nothing`);
  }
  for (const { path, text } of files) writeFileSync(join(ctx.dir, path), text);
}
const lstatOrUndefined = (p: string) => {
  try {
    return lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
};
// "#12" in text the writer wrote would turn into an issue reference (and "Closes #12" into a closing line).
const defuse = (text: string) => text.replace(/#(?=\d)/g, "#\u200b");

// The fix merges only on green checks, when the change is still open and its head is the pushed commit. Else a person decides.
async function mergeFix(ctx: StepContext, fix: Pushed): Promise<boolean> {
  const checks = await waitFor(ctx, () => ctx.codeHost.checks({ change: fix.ref, sha: fix.sha }));
  const now = await ctx.codeHost.change(fix.ref);
  let why: string | undefined =
    checks !== "green" ? `The pipeline is ${checks}, so the factory did not merge this fix.`
    : !now.open || now.head !== fix.sha ? "The change moved since the factory pushed it, so the factory did not merge this fix."
    : undefined;
  // The merge is the one write that skips a person, so it waits for the same switches as any auto merge.
  for (const name of ["improve", "auto_merge", "apply"] as const) {
    if (!why && !(await switchOn(ctx, name))) why = `The ${name} switch is off, so the factory did not merge this fix.`;
  }
  if (!why) {
    try {
      await ctx.codeHost.merge(fix.ref, fix.sha, FIX_TITLE);
      return true;
    } catch (e) {
      why = `The merge failed, so the factory did not merge this fix: ${String(e).slice(0, 300)}`;
    }
  }
  await ctx.codeHost.commentChange(fix.ref, why);
  await ctx.codeHost.assignChange(fix.ref, ctx.target.defaultApprover);
  return false;
}

export async function improve(ctx: StepContext, now: Date): Promise<{ change?: ChangeRef; fix?: ChangeRef; fixMerged?: boolean }> {
  if (!(await switchOn(ctx, "improve"))) {
    console.log("The improve switch is off on the dashboard.");
    return {};
  }
  // Rejects when the dashboard is down: the job fails before it writes anything.
  const { evidence, dropped } = await collectEvidence(ctx, now);
  if (evidence.length === 0) {
    console.log("No evidence this week, so no change.");
    return {};
  }
  console.log(`Evidence: ${evidence.length} items, ${dropped} dropped by the injection check.`);

  await ctx.repo.clone(await ctx.codeHost.baseBranch());
  const current: Current = {};
  for (const p of IMPROVE_PATHS) current[p] = await ctx.repo.readBase(p);
  const thresholds = readThresholds(current[THRESHOLDS_PATH]).values;
  const r = await agent(ctx, "writer", ctx.router.writer, { tools: "none", maxTurns: 1, prompt: improvePrompt({ evidence, current, thresholds }), cwd: ctx.dir });
  if (!r.ok) throw new Error("The writer run failed");
  const edits = parseProposal(r.text);
  const checked = checkEdits(edits, { links: new Set(evidence.map((e) => e.link)), current, dir: ctx.dir });
  for (const line of checked.dropped) console.log(`Dropped: ${line}`);
  if (checked.fixes.length + checked.changes.length === 0) return {};

  const day = now.toISOString().slice(0, 10);
  const out: Awaited<ReturnType<typeof improve>> = {};
  let fix: Pushed | undefined;
  if (checked.fixes.length) {
    const body = checked.fixes.map((e) => `\`${e.path}\`: \`${e.gone}\` no longer exists in the repo.`).join("\n");
    fix = await push(ctx, improveBranch("fix", day), FIX_TITLE, body, checked.fixes);
    out.fix = fix.ref;
    // The change branch starts from the base again, so it holds only the changes.
    writeAll(ctx, checked.fixes.map((e) => ({ path: e.path, text: current[e.path]! })));
  }
  if (checked.changes.length) {
    const body = checked.changes.map((e) => {
      const demoted = e.gone && edits.find((x) => x.path === e.path)?.kind === "fix" ? [`Proposed as a fix, but the factory could not confirm that it is only a rename of ${defuse(e.gone!)}.`] : [];
      return [`## ${e.path}`, "", defuse(e.why), "", ...demoted, ...(demoted.length ? [""] : []), "Evidence:", ...e.evidence.map((l) => `- ${l}`)].join("\n");
    }).join("\n\n");
    const title = `chore(factory): weekly instruction changes ${day}`;
    const change = await push(ctx, improveBranch("change", day), title, body, checked.changes);
    await ctx.codeHost.assignChange(change.ref, ctx.target.defaultApprover);
    out.change = change.ref;
  }
  // Last, so the change is open for people even when the fix does not merge.
  if (fix) out.fixMerged = await mergeFix(ctx, fix);
  return out;
}

export async function main(env: NodeJS.ProcessEnv = process.env) {
  if (env.FACTORY_SCHEDULE !== "improve") throw new Error("FACTORY_SCHEDULE must be improve");
  const ctx = makeContext(env);
  try {
    console.log(`Improve: ${JSON.stringify(await improve(ctx, new Date()))}`);
  } finally {
    await ctx.dashboard.flush(); // the usage events of the writer run
  }
}
if (isMain(import.meta.url)) await main();
