// Loaded by Pi (--extension) for author runs: every bash call goes through the same command guard as Claude Code.
// Self-contained on purpose: Pi loads this file by itself, so it imports only node modules.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOOKS_DIR = fileURLToPath(new URL("../../.agents/hooks", import.meta.url));

// Runs deny-dangerous.sh. Exit 2 is a block. Any other failure also blocks: no guard means no command.
export function guardCheck(command: string, hooksDir = HOOKS_DIR): { block: boolean; reason?: string } {
  const r = spawnSync(`${hooksDir}/deny-dangerous.sh`, { input: JSON.stringify({ tool_input: { command } }), encoding: "utf8" });
  if (r.status === 0) return { block: false };
  return { block: true, reason: (r.stderr ?? "").trim() || `command guard failed (${r.error?.message ?? `exit ${r.status}`})` };
}

// ponytail: the event name "tool_call", event.toolName and event.input.command follow Pi's extension docs.
// Confirm them on the runner's Pi version (`pi --help`, extension docs) before the first real author run.
export default function (pi: { on(event: string, handler: (e: any) => unknown): void }) {
  pi.on("tool_call", (e) => {
    if (e.toolName !== "bash") return undefined;
    const g = guardCheck(String(e.input?.command ?? ""));
    return g.block ? { block: true, reason: g.reason } : undefined;
  });
}
