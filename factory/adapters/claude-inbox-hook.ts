// Claude Code runs this after every tool call: `node --import tsx claude-inbox-hook.ts <inbox file>`.
// It prints the comments that came in since the last call, or stops the agent. Self-contained: it only uses node modules.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The inbox file has one JSON line per poll with news. `<file>.read` holds how many lines were read.
export function readNew(file: string): { comments: string[]; stop: boolean } {
  const out = { comments: [] as string[], stop: false };
  if (!existsSync(file)) return out;
  const lines = readFileSync(file, "utf8").split("\n").slice(0, -1); // a last line without its newline is still being written
  const read = existsSync(`${file}.read`) ? Number(readFileSync(`${file}.read`, "utf8")) || 0 : 0;
  writeFileSync(`${file}.read`, String(lines.length));
  for (const line of lines.slice(read)) {
    try {
      const r = JSON.parse(line);
      out.comments.push(...r.comments);
      out.stop ||= r.stop === true;
    } catch { /* skip a broken line */ }
  }
  return out;
}

export function hookOutput(file: string): object | undefined {
  const { comments, stop } = readNew(file);
  if (stop) return { continue: false, stopReason: "@factory stop" };
  if (comments.length > 0) return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: comments.join("\n\n") } };
  return undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = hookOutput(process.argv[2] ?? "");
  if (out) console.log(JSON.stringify(out));
}
