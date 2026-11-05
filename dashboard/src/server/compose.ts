// The one place that picks the dashboard's adapters. Mirrors factory/compose.ts.
import { makeGitHubTracker } from "./adapters/github-tracker";
import { makeGitLabCi } from "./adapters/gitlab-ci";
import { makeGitLabTracker } from "./adapters/gitlab-tracker";
import { makeGrafana, NOT_SET_UP } from "./adapters/grafana";
import { makeLocalCi } from "./adapters/local-ci";
import { NotSetUp } from "./not-set-up";
import type { BoardRow, Ci, HostMetrics, Tracker } from "./seams";
import { readTargets, type TargetInfo } from "./targets";

const CACHE_MS = 15_000;

const trackers = (fetchFn: typeof fetch): Record<string, Tracker> => {
  const github = makeGitHubTracker(fetchFn);
  return { gitlab: makeGitLabTracker(fetchFn), github, "github-project": github };
};
const defaultTrackers = trackers((...a) => fetch(...a));

function pick(all: Record<string, Tracker>, t: TargetInfo) {
  const tracker = all[t.tracker];
  if (!tracker) throw new Error(`${t.name}: unknown tracker ${t.tracker}`);
  return tracker;
}

export const trackerOf = (t: TargetInfo): Tracker => pick(defaultTrackers, t);

// Where one file of the change shows in the code host's diff: base, then the hex hash of the file's path.
export type FileLink = { base: string; hash: "SHA-256" | "SHA-1" };
export const fileLinkOf = (t: TargetInfo, changeUrl: string): FileLink | undefined =>
  ({ github: { base: `${changeUrl}/files#diff-`, hash: "SHA-256" }, gitlab: { base: `${changeUrl}/diffs#`, hash: "SHA-1" } } as Record<string, FileLink>)[t.codeHost];

export const codeHostName = (t: TargetInfo): string => ({ gitlab: "GitLab", github: "GitHub" } as Record<string, string>)[t.codeHost] ?? t.codeHost;

// Every target's open work items, each from its own tracker. A tracker that is not set up leaves its targets out; any other error fails the board.
export function makeBoard(fetchFn: typeof fetch = fetch, now: () => Date = () => new Date()) {
  const all = trackers(fetchFn);
  let cached: { at: number; rows: Promise<BoardRow[]> } | undefined;

  async function fetchBoard() {
    const groups = new Map<Tracker, TargetInfo[]>();
    for (const t of readTargets()) {
      const tracker = pick(all, t);
      groups.set(tracker, [...(groups.get(tracker) ?? []), t]);
    }
    const lists = [...groups].map(([tracker, targets]) => tracker.rows(targets).catch((e) => (e instanceof NotSetUp ? [] : Promise.reject(e))));
    return (await Promise.all(lists)).flat();
  }

  return {
    board() {
      if (!cached || now().getTime() - cached.at >= CACHE_MS) {
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

// What runs the factory: the factory's own worker with FACTORY_CI=local (seams.yml ci: local), else GitLab CI. One instance.
export const getCi = () => (ci ??= process.env.FACTORY_CI === "local" ? makeLocalCi() : makeGitLabCi());

// No host metrics: no log sources, and the same not-set-up answer for every call.
export const makeNoHostMetrics = (): HostMetrics => ({
  sources: [],
  hostStats: async () => Promise.reject(new NotSetUp(NOT_SET_UP)),
  logs: async () => Promise.reject(new NotSetUp(NOT_SET_UP)),
});

// Grafana when GRAFANA_URL is set, else nothing. Read on every call, so a new setting needs no restart.
export const getHostMetrics = (): HostMetrics => (process.env.GRAFANA_URL ? makeGrafana() : makeNoHostMetrics());
