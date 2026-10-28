import picomatch from "picomatch";
import type { Target } from "./types";

const SECRET_PATTERNS = [/glpat-[A-Za-z0-9_-]{20,}/g, /-----BEGIN [A-Z ]*PRIVATE KEY-----/g];

/** Returns the secret-looking strings found in the text. */
export function findSecrets(text: string): string[] {
  return SECRET_PATTERNS.flatMap((re) => text.match(re) ?? []);
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

function pathRule(rule: RuleResult["rule"], files: ChangedFile[], globs: string[], what: string): RuleResult {
  const match = picomatch(globs, { dot: true });
  const hits = [...new Set(files.flatMap((f) => [f.oldPath, f.newPath]).filter((p) => match(p)))];
  return { rule, passed: hits.length === 0, detail: hits.length ? `Changed ${what}: ${hits.join(", ")}` : `No ${what} changed` };
}

/** Runs all five hard rules. Every rule always returns one result. */
export function checkHardRules(files: ChangedFile[], diffText: string, target: Target, pipelineGreen: boolean): RuleResult[] {
  const lines = files.reduce((sum, f) => sum + f.added + f.removed, 0);
  const secrets = findSecrets(diffText);
  return [
    pathRule("protected-path", files, target.protectedPaths, "protected files"),
    pathRule("dependency-file", files, target.dependencyFiles, "dependency files"),
    { rule: "size", passed: lines <= target.maxChangedLines, detail: `${lines} lines changed, the limit is ${target.maxChangedLines}` },
    { rule: "secret", passed: secrets.length === 0, detail: secrets.length ? `Found ${secrets.length} secret-looking value(s) in the diff` : "No secrets found in the diff" },
    { rule: "pipeline", passed: pipelineGreen, detail: pipelineGreen ? "Pipeline is green" : "Pipeline is not green" },
  ];
}
