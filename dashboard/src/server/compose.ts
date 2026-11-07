// The one place that picks the dashboard's adapters. Mirrors factory/compose.ts.
import { makeGitHubTracker } from "./adapters/github-tracker";
import { makeGitLabCi } from "./adapters/gitlab-ci";
import { makeGitLabTracker } from "./adapters/gitlab-tracker";
import { makeGrafana, NOT_SET_UP } from "./adapters/grafana";
import { makeLocalCi } from "./adapters/local-ci";
import { NotSetUp } from "./not-set-up";
import type { BoardRow, Ci, HostMetrics, Tracker } from "./seams";
import { readTargets, type CodeHostKey, type TargetInfo, type TrackerKey } from "./targets";

const CACHE_MS = 15_000;

const trackers = (fetchFn: typeof fetch): Record<TrackerKey, Tracker> => {
  const github = makeGitHubTracker(fetchFn);
  return { gitlab: makeGitLabTracker(fetchFn), github, "github-project": github };
};
const defaultTrackers = trackers((...a) => fetch(...a));

export const trackerOf = (t: TargetInfo): Tracker => defaultTrackers[t.tracker];

// Where one file of the change shows in the code host's diff: base, then the hex hash of the file's path.
export type FileLink = { base: string; hash: "SHA-256" | "SHA-1" };
export const fileLinkOf = (t: TargetInfo, changeUrl: string): FileLink =>
  ({ github: { base: `${changeUrl}/files#diff-`, hash: "SHA-256" }, gitlab: { base: `${changeUrl}/diffs#`, hash: "SHA-1" } } satisfies Record<CodeHostKey, FileLink>)[t.codeHost];

const CODE_HOST_NAME: Record<CodeHostKey, string> = { gitlab: "GitLab", github: "GitHub" };
export const codeHostName = (t: TargetInfo): string => CODE_HOST_NAME[t.codeHost];

// Every target's work items in a factory state, each from its own tracker. A tracker that is not set up leaves its targets out; any other error fails the board.
export function makeBoard(fetchFn: typeof fetch = fetch, now: () => Date = () => new Date()) {
  const all = trackers(fetchFn);
  let cached: { at: number; rows: Promise<BoardRow[]> } | undefined;

  async function fetchBoard() {
    const groups = new Map<Tracker, TargetInfo[]>();
    for (const t of readTargets()) {
      const tracker = all[t.tracker];
      groups.set(tracker, [...(groups.get(tracker) ?? []), t]);
    }
    const lists = [...groups].map(([tracker, targets]) => tracker.rows(targets).catch((e) => (e instanceof NotSetUp ? [] : Promise.reject(e))));
    return (await Promise.all(lists)).flat();
  }

  return {
    // fresh skips the cache: the board's Refresh button asks for it.
    board(fresh = false) {
      if (fresh || !cached || now().getTime() - cached.at >= CACHE_MS) {
        const entry = { at: now().getTime(), rows: fetchBoard() };
        cached = entry;
        entry.rows.catch(() => cached === entry && (cached = undefined)); // do not cache a failure
      }
      return cached.rows;
    },
  };
}

let board: ReturnType<typeof makeBoard> | undefined;

// One instance, so the 15 s board cache is shared by every request.
export const getBoard = () => (board ??= makeBoard());

let ci: Ci | undefined;

// What runs the factory, from FACTORY_CI: gitlab (GitLab CI), local (the factory's worker, seams.yml ci: local), or unset
// for none, as on a Mac running ./local-factory.sh, where the steps honour stops themselves. One instance.
export const getCi = () => (ci ??= process.env.FACTORY_CI === "gitlab" ? makeGitLabCi() : process.env.FACTORY_CI === "local" ? makeLocalCi() : makeNoCi());

// No CI: every call answers not set up, and the loop skips the stop fallback, dispatch runs and imports.
export const makeNoCi = (): Ci => {
  const no = async () => Promise.reject(new NotSetUp("FACTORY_CI is not set, so the dashboard cancels no runs, starts no dispatch runs and imports no events. Set it to local or gitlab."));
  return { runningJobs: no, jobLog: no, cancel: no, startDispatch: no, importEvents: no };
};

// No host metrics: no log sources, and the same not-set-up answer for every call.
export const makeNoHostMetrics = (): HostMetrics => ({
  sources: [],
  hostStats: async () => Promise.reject(new NotSetUp(NOT_SET_UP)),
  logs: async () => Promise.reject(new NotSetUp(NOT_SET_UP)),
});

// Grafana when GRAFANA_URL is set, else nothing. Read on every call, so a new setting needs no restart.
export const getHostMetrics = (): HostMetrics => (process.env.GRAFANA_URL ? makeGrafana() : makeNoHostMetrics());
