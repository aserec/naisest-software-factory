// The dashboard's outside tools, in factory words. Pages and components use these types and never a tool's own words.
import type { FactoryState } from "software-factory/run-events";
import type { TargetInfo } from "./targets";

export type { FactoryState };

// One board column per state, in this order.
export const STATES: FactoryState[] = ["ready", "running", "waiting", "needs_info", "needs_approval", "done", "stopped", "blocked"];

export type Risk = "trivial" | "low" | "medium" | "high";

export interface BoardRow { target: string; ticket: string; title: string; state: FactoryState; url: string; updatedAt: string; risk?: Risk }

// Where a target's work items live. A target's `tracker` key picks it.
export interface Tracker {
  readonly name: string; // the display name
  rows(targets: TargetInfo[]): Promise<BoardRow[]>; // open work items in a factory state; throws NotSetUp without its address or read token
  ticketUrl(target: TargetInfo, ticket: string): string; // empty when the tracker is not set up
}
