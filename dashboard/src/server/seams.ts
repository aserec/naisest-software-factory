// The dashboard's outside tools, in factory words. Pages and components use these types and never a tool's own words.
import type { Provider } from "next-auth/providers";
import { STATES, type FactoryState } from "software-factory/run-events";
import type { Db } from "./db";
import type { TargetInfo } from "./targets";

export { STATES, type FactoryState }; // STATES: one board column per state, in this order

export type Risk = "trivial" | "low" | "medium" | "high";

// The triage risk from the work item's factory_risk_* label, or undefined before triage. Every tracker reads the same labels.
export const triageRisk = (labels: string[]) => labels.map((l) => /^factory_risk_(trivial|low|medium|high)$/.exec(l)?.[1] as Risk | undefined).find(Boolean);

// Fills blockedBy on every open ready row, as the factory's poller reads blockers. A failed read leaves blockedBy unknown.
export async function addBlockers(rows: BoardRow[], blockersOf: (r: BoardRow) => Promise<string[]>): Promise<BoardRow[]> {
  await Promise.all(rows.filter((r) => r.state === "ready" && !r.closed).map(async (r) => (r.blockedBy = await blockersOf(r).catch(() => undefined))));
  return rows;
}

export interface BoardRow extends ChangeView { target: string; ticket: string; title: string; state: FactoryState; url: string; updatedAt: string; risk?: Risk; boardUrl?: string; closed?: boolean; blockedBy?: string[] } // boardUrl: the tracker's own board the work item sits on. closed: the issue is closed in the tracker. blockedBy: the URLs of the open work items an open ready one waits for; the factory starts it once they are closed. Undefined when the tracker could not tell

// The work item's open change as the code host shows it now. Each field is undefined when the host cannot tell (no change, or still computing).
export interface ChangeView { changeUrl?: string; conflicts?: boolean; mergeBlock?: string; checksFailed?: boolean } // mergeBlock: why the change cannot merge now, as a phrase; none when it can. checksFailed: a check or pipeline of the change failed

// Where a target's work items live. A target's `tracker` key picks it.
export interface Tracker {
  readonly name: string; // the display name
  rows(targets: TargetInfo[]): Promise<BoardRow[]>; // work items in a factory state, open or closed, newest update first; throws NotSetUp without its address or read token
  ticketUrl(target: TargetInfo, ticket: string): string; // empty when the tracker is not set up
  postRelay(target: TargetInfo, ticket: string, body: string): Promise<Response>; // posts a relayed message as the relay bot; throws NotSetUp without the relay token
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

// A way to sign in, and the rights check behind it. signIns() in sign-ins.ts lists the ones that are on.
export interface SignIn {
  readonly id: string; // the Auth.js provider id
  readonly name: string; // the display name
  provider(): Provider;
  check(account: { access_token?: string }, profile: unknown): Promise<{ user: SessionUser } | { refused: string }>; // at sign-in
  canAct(user: SessionUser): Promise<true | { refused: string }>; // on every control action, read again each time
  messages: Record<string, string>; // the text for each `refused` key
}

export interface HostStat { host: string; diskUsedPct: number; memUsedPct: number }
export interface LogLine { at: string; host: string; line: string }

// Disk, memory and logs of the machines that run the factory's jobs. Grafana picks it when GRAFANA_URL is set.
export interface HostMetrics {
  readonly sources: string[]; // the log sources `logs` accepts, as tab names; empty when none is set up
  hostStats(): Promise<HostStat[]>; // throws NotSetUp without its settings
  logs(q: { source: string; host?: string; minutes: number }): Promise<LogLine[]>; // newest first; throws NotSetUp without its settings, and an Error for a source outside `sources`
}
