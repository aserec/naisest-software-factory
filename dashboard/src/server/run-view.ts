import { STATES, type ControlRequest, type FactoryState, type RunEvent } from "software-factory/run-events";

// The one place that reads a run's state: what it is in, what a person may do, and whether it is stuck.
// Pure, so the server (db.request, the routes) and the run page read the same answer.

export type Action = ControlRequest["kind"]; // stop | resume | restart
export interface LastStep { step: string; startedAt: string; ended: boolean }

export interface RunView {
  state?: FactoryState; // the run's newest label_change, else the fallback
  ended: boolean; // the run has a run_end event
  paused: boolean; // halted before a final state and waits to go on
  stuck: boolean; // the last step runs past its limit, and the run is neither ended nor paused
  lastStep?: LastStep;
  cancelled: boolean; // a pipeline cancel ended the run's stop request
  restarted: boolean; // a restart of this run is done
  pending: Action[]; // requests that wait for the factory; a cancelled stop does not count
  actions: Action[]; // what a person may request now
  refusals: Partial<Record<Action, string>>; // why each action that is not in `actions` is refused
}

export interface RunViewInput {
  events: RunEvent[]; // of the run, oldest first; other event types are ignored
  requests?: ControlRequest[]; // of the run
  newer?: boolean; // a newer run of the same work item exists (Ruling R46)
  limits?: Record<string, number>; // minutes per step; a step without a limit is never stuck
  now?: Date;
  fallback?: FactoryState; // the work item's tracker state, for a run that sent no label_change
}

// The states of a run that halted before a final state and waits to go on.
const PAUSED: FactoryState[] = ["needs_approval", "needs_info", "stopped", "blocked", "waiting"];
const ACTIONS: Action[] = ["stop", "resume", "restart"];

/** The last step after one more event. A patch step runs inside code review or the gate, so the outer step stays the last step. */
export function trackStep(last: LastStep | undefined, e: { type: string; step?: string; at: string }): LastStep | undefined {
  if (e.type === "step_start" && e.step !== "patch") return { step: e.step ?? "", startedAt: e.at, ended: false };
  if (e.type === "step_end" && last && last.step === (e.step ?? "")) return { ...last, ended: true };
  return last;
}

export function runView({ events, requests = [], newer = false, limits = {}, now = new Date(), fallback }: RunViewInput): RunView {
  let state: FactoryState | undefined;
  let lastStep: LastStep | undefined;
  let ended = false;
  for (const e of events) {
    // The one place that reads a label_change state. Rows saved before the factory dropped the prefix hold the tracker's label name, factory_<state>.
    if (e.type === "label_change") state = STATES.find((s) => s === e.data.to.replace(/^factory_/, ""));
    else if (e.type === "run_end") ended = true;
    else lastStep = trackStep(lastStep, e);
  }
  state ??= fallback;
  const paused = !!state && PAUSED.includes(state);
  const limit = lastStep && limits[lastStep.step];
  const stuck = !ended && !paused && !!lastStep && !lastStep.ended && limit !== undefined && now.getTime() - Date.parse(lastStep.startedAt) > limit * 60_000;

  const cancelled = requests.some((r) => r.kind === "stop" && r.outcome === "cancelled");
  const restarted = requests.some((r) => r.kind === "restart" && r.outcome === "done");
  const pending = requests.filter((r) => !r.doneAt && r.outcome !== "cancelled").map((r) => r.kind);
  const refusal = (kind: Action): string | undefined => {
    if (requests.some((r) => r.kind === kind && !r.doneAt)) return "already requested";
    if (ended) return "run already ended";
    if (restarted) return "run already restarted"; // a done restart ended this run: a new run carries on
    if (pending.length) return "a request is already waiting";
    if (kind === "stop") return state === "running" ? undefined : "run is not running";
    // The poller acts on the work item, so the run must be its newest (Ruling R46).
    if (newer) return "run is not the ticket's newest run";
    // A run ended by a pipeline cancel saved nothing to resume from, but it can be restarted (spec 6.1, Ruling R18).
    if (cancelled) return kind === "resume" ? "the run was cancelled, use Restart" : undefined;
    return state === "stopped" ? undefined : "run is not stopped";
  };
  const refusals: RunView["refusals"] = {};
  const actions = ACTIONS.filter((k) => {
    const why = refusal(k);
    if (why) refusals[k] = why;
    return !why;
  });
  return { state, ended, paused, stuck, lastStep, cancelled, restarted, pending, actions, refusals };
}
