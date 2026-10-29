// Loaded by Pi (--extension) for author runs: every bash call goes through the same command guard as Claude Code.
// Pi loads this file by itself, so it imports only node modules and ../inbox-file (a relative import, which Pi's loader resolves; confirm on the runner).
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readNew } from "../inbox-file";

const HOOKS_DIR = fileURLToPath(new URL("../../.agents/hooks", import.meta.url));

// Runs deny-dangerous.sh. Exit 2 is a block. Any other failure also blocks: no guard means no command.
export function guardCheck(command: string, hooksDir = HOOKS_DIR): { block: boolean; reason?: string } {
  const r = spawnSync(`${hooksDir}/deny-dangerous.sh`, { input: JSON.stringify({ tool_input: { command } }), encoding: "utf8" });
  if (r.status === 0) return { block: false };
  return { block: true, reason: (r.stderr ?? "").trim() || `command guard failed (${r.error?.message ?? `exit ${r.status}`})` };
}

// The inbox file is in Pi's home (PI_CODING_AGENT_DIR). The format is read by ../inbox-file, the same code the Claude hook uses.
// ponytail: the event names "tool_call" and "tool_result", event.toolName, event.input.command, pi.sendMessage({ customType, content, display }, { deliverAs: "steer" })
// and ctx.abort() follow Pi's extension docs. ctx.abort()'s behavior is not documented there.
// Confirm all of them on the runner's Pi version (`pi --help`, extension docs) before the first real author run.
export default function (pi: { on(event: string, handler: (e: any, ctx?: any) => unknown): void; sendMessage?(m: object, o?: object): void }) {
  pi.on("tool_call", (e) => {
    if (e.toolName !== "bash") return undefined;
    const g = guardCheck(String(e.input?.command ?? ""));
    return g.block ? { block: true, reason: g.reason } : undefined;
  });
  // After each tool call: hand new comments to the agent, or stop it.
  pi.on("tool_result", (_e, ctx) => {
    const { comments, stop } = readNew(join(process.env.PI_CODING_AGENT_DIR ?? "", "inbox.jsonl"));
    if (stop) {
      if (typeof ctx?.abort === "function") ctx.abort();
      else console.error("factory inbox: @factory stop found, but this Pi has no ctx.abort(); the agent keeps running");
    }
    else if (comments.length > 0) pi.sendMessage?.({ customType: "factory-inbox", content: comments.join("\n\n"), display: true }, { deliverAs: "steer" });
    return undefined;
  });
}
