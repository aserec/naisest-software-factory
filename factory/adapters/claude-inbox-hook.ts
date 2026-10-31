// Claude Code runs this after every tool call: `node --import tsx claude-inbox-hook.ts <inbox file>`.
// It prints the comments that came in since the last call, or stops the agent. It uses only node modules and ../inbox-file.
import { fileURLToPath } from "node:url";
import { readNew } from "../inbox-file";

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
