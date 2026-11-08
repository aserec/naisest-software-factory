import type { FactoryState } from "@/server/seams";

// The board's name for each state. Outside board.tsx so server pages can read it too.
export const STATE: Record<FactoryState, string> = {
  needs_approval: "Needs approval",
  needs_info: "Needs info",
  info_answered: "Info answered",
  stopped: "Stopped",
  blocked: "Blocked",
  running: "Running",
  waiting: "Waiting",
  ready: "Ready",
  done: "Done",
};
