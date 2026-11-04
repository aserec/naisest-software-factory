// The dashboard's outside tools, in factory words. Pages and components use these types and never a tool's own words.
import type { Provider } from "next-auth/providers";
import type { FactoryState } from "software-factory/run-events";
import type { Db } from "./db";
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

export interface Job { job: string; name: string; run: string; startedAt: string; runner?: string }

// What runs the factory's steps. FACTORY_CI picks it.
export interface Ci {
  runningJobs(): Promise<Job[]>; // throws NotSetUp when this CI has no job list
  jobLog(job: string): Promise<string>; // the end of the job's log; throws NotSetUp when this CI has no job log
  cancel(run: string): Promise<void>; // `run` is the id the steps send in their events (step_start's pipeline field)
  startDispatch(target: string): Promise<void>; // starts the factory's dispatch run for the target
  importEvents(db: Db): Promise<number>; // adds the events of finished jobs to db, and gives how many were new
}

// Who is signed in, as the session cookie keeps it. `signIn` is the id of the SignIn they used.
export interface SessionUser { userId: number; username: string; signIn: string }

// A way to sign in, and the rights check behind it. compose's signIns() lists the ones that are on.
export interface SignIn {
  readonly id: string; // the Auth.js provider id
  readonly name: string; // the display name
  provider(): Provider;
  check(account: { access_token?: string }, profile: unknown): Promise<{ user: SessionUser } | { refused: string }>; // at sign-in
  canAct(user: SessionUser): Promise<true | { refused: string }>; // on every control action, read again each time
  messages: Record<string, string>; // the text for each `refused` key
}
