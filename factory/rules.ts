import picomatch from "picomatch";
import type { Target } from "./types";

// GitLab personal and CI job tokens, Anthropic keys (the Claude OAuth token too), private keys.
const SECRET_PATTERNS = [/glpat-[A-Za-z0-9_-]{20,}/g, /gh[pousr]_[A-Za-z0-9]{36,}/g, /github_pat_[A-Za-z0-9_]{22,}/g, /glcbt-[A-Za-z0-9_-]+/g, /sk-ant-[A-Za-z0-9_-]+/g, /-----BEGIN [A-Z ]*PRIVATE KEY-----/g];

// The secret values this process holds (makeContext adds them). Short values are skipped: real tokens
// and webhook URLs are long, and a short value would match ordinary text.
const known = new Set<string>();
export function addKnownSecrets(...values: (string | undefined)[]): void {
  for (const v of values) if (v && v.length >= 16) known.add(v);
}

/** The text with every secret pattern and every secret value this process holds replaced by [secret]. */
export function maskSecrets(text: string): string {
  for (const v of known) text = text.replaceAll(v, "[secret]");
  for (const re of SECRET_PATTERNS) text = text.replace(re, "[secret]");
  return text;
}

/** What findSecrets returns in place of a secret value this process holds. */
export const HELD_SECRET = "[a secret value this process holds]";

/** Returns the secret-looking strings found in the text. A known secret value shows as a placeholder, never as itself. */
export function findSecrets(text: string): string[] {
  const held = [...known].filter((v) => text.includes(v)).map(() => HELD_SECRET);
  return [...SECRET_PATTERNS.flatMap((re) => text.match(re) ?? []), ...held];
}

export interface ChangedFile { oldPath: string; newPath: string; added: number; removed: number; binary: boolean }
export interface RuleResult { rule: "protected-path" | "dependency-file" | "size" | "secret" | "pipeline"; passed: boolean; detail: string }

/** Parses the output of `git diff --numstat -z -M`. Binary files show "-" and count as 0 lines. */
export function parseNumstat(gitNumstatZ: string): ChangedFile[] {
  const parts = gitNumstatZ.split("\0");
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry === "") continue;
    const first = entry.indexOf("\t");
    const second = first < 0 ? -1 : entry.indexOf("\t", first + 1);
    if (second < 0) throw new Error(`Bad numstat entry: ${JSON.stringify(entry)}`);
    const added = entry.slice(0, first);
    const removed = entry.slice(first + 1, second);
    const path = entry.slice(second + 1);
    // A rename has an empty path here; the old and new paths are the next two parts.
    const [oldPath, newPath] = path === "" ? [parts[i + 1], parts[i + 2]] : [path, path];
    if (path === "") i += 2;
    if (!oldPath || !newPath) throw new Error(`Bad numstat rename: ${JSON.stringify(entry)}`);
    const binary = added === "-" && removed === "-";
    // Counts must be plain digits, or both "-" for a binary file. Anything else fails closed.
    if (!binary && !(/^\d+$/.test(added) && /^\d+$/.test(removed))) {
      throw new Error(`Bad numstat counts: ${JSON.stringify(entry)}`);
    }
    files.push({ oldPath, newPath, added: binary ? 0 : Number(added), removed: binary ? 0 : Number(removed), binary });
  }
  return files;
}

// ponytail: fixed test globs; a target config list when a target names its tests differently.
const isTest = picomatch(["**/*.{test,spec}.*", "**/__tests__/**", "**/tests/**", "**/test/**", "**/e2e/**"], { dot: true });
/** The diff changes test files only. */
export const testOnly = (files: ChangedFile[]) => files.length > 0 && files.every((f) => isTest(f.newPath) && isTest(f.oldPath));

function pathRule(rule: RuleResult["rule"], files: ChangedFile[], globs: string[], what: string): RuleResult {
  const match = picomatch(globs, { dot: true });
  const hits = [...new Set(files.flatMap((f) => [f.oldPath, f.newPath]).filter((p) => match(p)))];
  return { rule, passed: hits.length === 0, detail: hits.length ? `Changed ${what}: ${hits.join(", ")}` : `No ${what} changed` };
}

/** Runs all five hard rules. Every rule always returns one result. */
export function checkHardRules(files: ChangedFile[], diffText: string, target: Target, pipelineGreen: boolean, pipelineDetail?: string): RuleResult[] {
  const lines = files.reduce((sum, f) => sum + f.added + f.removed, 0);
  const secrets = findSecrets(diffText);
  return [
    pathRule("protected-path", files, target.protectedPaths, "protected files"),
    pathRule("dependency-file", files, target.dependencyFiles, "dependency files"),
    target.maxChangedLines === undefined
      ? { rule: "size", passed: true, detail: `${lines} lines changed, no limit` }
      : { rule: "size", passed: lines <= target.maxChangedLines, detail: `${lines} lines changed, the limit is ${target.maxChangedLines}` },
    { rule: "secret", passed: secrets.length === 0, detail: secrets.length ? `Found ${secrets.length} secret-looking value(s) in the diff` : "No secrets found in the diff" },
    { rule: "pipeline", passed: pipelineGreen, detail: pipelineDetail ?? (pipelineGreen ? "Pipeline is green" : "Pipeline is not green") },
  ];
}
