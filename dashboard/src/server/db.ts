import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SWITCHES, type ControlRequest, type EventType, type RunEvent, type Dispatch, type DispatchInput, type SwitchName } from "software-factory/run-events";
import { runView, trackStep, type RunView } from "./run-view";
import type { FactoryState } from "./seams";

export interface RunSummary {
  run: string;
  target: string;
  ticket: string;
  startedAt: string;
  endedAt?: string;
  outcome?: string;
  costUsd: number;
  lastStep?: { step: string; startedAt: string; ended: boolean };
  round?: number; // the highest code-review round with a finding
  mergeRisk?: number; // Jev 2's diff_risk, from the decision event
  mergeRiskMax?: number; // the target's diffRiskMax, from the decision event
  changeUrl?: string; // the change to review, from the decision event
}

export interface Db {
  addEvents(events: RunEvent[]): number;
  events(q: { run?: string; after?: number; limit?: number }): { events: (RunEvent & { seq: number })[]; cursor: number };
  /** Events of the target at or after `since` with one of the types, oldest first. */
  history(q: { target: string; since: string; types: EventType[]; limit: number }): RunEvent[];
  runs(q: { target?: string; ticket?: string }): RunSummary[];
  switches(target: string): Record<SwitchName, boolean>;
  setSwitch(scope: string, name: SwitchName, on: boolean, user: string): void;
  /** Saves the request and its audit event (type = kind) in one transaction. */
  request(r: Omit<ControlRequest, "id" | "at">): ControlRequest | { refused: string };
  requests(q: { target?: string; pending?: boolean; sinceMinutes?: number }): ControlRequest[];
  /** True when the run has a run_end event. */
  ended(run: string): boolean;
  /** What state the run is in and what may be done to it (see run-view.ts); undefined for a run with no events. fallback: the work item's tracker state, for a run that sent no label_change. */
  view(run: string, o?: { limits?: Record<string, number>; now?: Date; fallback?: FactoryState }): RunView | undefined;
  finish(id: string, outcome: NonNullable<ControlRequest["outcome"]>): void;
  addDispatch(s: DispatchInput): Dispatch;
  /** Pending dispatches of the target, oldest first. */
  dispatches(target: string): Dispatch[];
  dispatchDone(id: string): void;
  /** Targets with a waiting dispatch whose run was never started, or last started before `startedBefore`. */
  dispatchTargets(startedBefore: string): string[];
  dispatchStarted(target: string, at: string): void;
  isImported(job: string): boolean;
  markImported(job: string): void;
  prune(now: Date): void;
  backup(dir: string, now: Date): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, run TEXT NOT NULL, parent TEXT, at TEXT NOT NULL,
  target TEXT NOT NULL, ticket TEXT NOT NULL, pipeline TEXT, job TEXT, step TEXT, type TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run ON events (run, seq);
CREATE INDEX IF NOT EXISTS events_ticket ON events (target, ticket);
CREATE INDEX IF NOT EXISTS events_type ON events (type, target, ticket);
CREATE TABLE IF NOT EXISTS switches (
  scope TEXT NOT NULL, name TEXT NOT NULL, "on" INTEGER NOT NULL, user TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (scope, name)
);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, run TEXT NOT NULL, target TEXT NOT NULL, ticket TEXT NOT NULL,
  user TEXT NOT NULL, at TEXT NOT NULL, outcome TEXT, done_at TEXT
);
CREATE TABLE IF NOT EXISTS dispatches (
  id TEXT PRIMARY KEY, target TEXT NOT NULL, source TEXT NOT NULL, key TEXT NOT NULL, title TEXT NOT NULL,
  details TEXT NOT NULL, link TEXT, at TEXT NOT NULL, started_at TEXT, done_at TEXT
);
CREATE INDEX IF NOT EXISTS dispatches_pending ON dispatches (target, done_at, at);
CREATE TABLE IF NOT EXISTS imported_jobs (job TEXT PRIMARY KEY, at TEXT NOT NULL);`;

const DAY_MS = 864e5;
const KEEP_BACKUPS = 7;
const BACKUP_FILE = /^factory-\d{4}-\d{2}-\d{2}\.db$/;

type Row = Record<string, unknown>;
const text = (v: unknown) => (v == null ? undefined : (v as string));

function toEvent(r: Row): RunEvent & { seq: number } {
  const e: RunEvent & { seq: number } = { seq: r.seq as number, id: r.id as string, run: r.run as string, at: r.at as string, target: r.target as string, ticket: r.ticket as string, type: r.type as RunEvent["type"], data: JSON.parse(r.data as string) };
  for (const k of ["parent", "pipeline", "job", "step"] as const) if (r[k] != null) e[k] = r[k] as string;
  return e;
}

function toRequest(r: Row): ControlRequest {
  const q: ControlRequest = { id: r.id as string, kind: r.kind as ControlRequest["kind"], run: r.run as string, target: r.target as string, ticket: r.ticket as string, user: r.user as string, at: r.at as string };
  if (r.outcome != null) q.outcome = r.outcome as ControlRequest["outcome"];
  if (r.done_at != null) q.doneAt = r.done_at as string;
  return q;
}

export const EVENTS_SQL = (run: boolean) => `SELECT * FROM events WHERE seq > ?${run ? " AND run = ?" : ""} ORDER BY seq LIMIT ?`;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);

  const insertEvent = db.prepare("INSERT OR IGNORE INTO events (id, run, parent, at, target, ticket, pipeline, job, step, type, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  // A pending request is one with no done_at. "cancelled" keeps it pending (Ruling R4) and is never overwritten.
  const finishStmt = db.prepare("UPDATE requests SET done_at = ?, outcome = CASE WHEN outcome = 'cancelled' THEN outcome ELSE ? END WHERE id = ?");
  const cancelStmt = db.prepare("UPDATE requests SET outcome = 'cancelled' WHERE id = ?");
  const ended = (run: string) => db.prepare("SELECT 1 FROM events WHERE run = ? AND type = 'run_end'").get(run) !== undefined;
  // Only the events the run view reads, so a run with thousands of tool calls stays cheap.
  const viewEvents = db.prepare("SELECT * FROM events WHERE run = ? AND type IN ('step_start', 'step_end', 'label_change', 'run_end') ORDER BY seq");
  const finishStops = db.prepare("UPDATE requests SET done_at = ?, outcome = CASE WHEN outcome = 'cancelled' THEN outcome ELSE 'stopped' END WHERE run = ? AND kind = 'stop' AND done_at IS NULL");

  // Prepared once per distinct SQL. Optional filters are added to the SQL, not tested with `? IS NULL`, so SQLite can pick an index.
  const cache = new Map<string, ReturnType<typeof db.prepare>>();
  const stmt = (sql: string) => cache.get(sql) ?? (cache.set(sql, db.prepare(sql)), cache.get(sql)!);

  function view(run: string, o: { limits?: Record<string, number>; now?: Date; fallback?: FactoryState } = {}): RunView | undefined {
    const first = db.prepare("SELECT target, ticket FROM events WHERE run = ? ORDER BY seq LIMIT 1").get(run) as Row | undefined;
    if (!first) return undefined;
    // The poller acts on the work item, so a run must be its newest (Ruling R46).
    const newer = db.prepare("SELECT 1 FROM events WHERE type = 'run_start' AND target = ? AND ticket = ? AND run != ? AND seq > (SELECT MIN(seq) FROM events WHERE run = ? AND type = 'run_start')").get(first.target as string, first.ticket as string, run, run) !== undefined;
    const requests = (db.prepare("SELECT * FROM requests WHERE run = ? ORDER BY at, rowid").all(run) as Row[]).map(toRequest);
    return runView({ events: (viewEvents.all(run) as Row[]).map(toEvent), requests, newer, ...o });
  }

  function inTransaction<T>(fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  // Call inside a transaction.
  function insertEvents(events: RunEvent[]): number {
    let added = 0;
    for (const e of events) {
      const r = insertEvent.run(e.id, e.run, e.parent ?? null, e.at, e.target, e.ticket, e.pipeline ?? null, e.job ?? null, e.step ?? null, e.type, JSON.stringify(e.data));
      if (r.changes === 0) continue;
      added++;
      if (e.type === "step_end" && e.data.outcome === "stopped") finishStops.run(new Date().toISOString(), e.run);
    }
    return added;
  }
  const addEvents = (events: RunEvent[]) => inTransaction(() => insertEvents(events));

  return {
    addEvents,

    events({ run, after = 0, limit = 500 }) {
      const rows = stmt(EVENTS_SQL(run != null)).all(...(run != null ? [after, run, limit] : [after, limit])) as Row[];
      const events = rows.map(toEvent);
      return { events, cursor: events.length ? events[events.length - 1].seq : after };
    },

    history({ target, since, types, limit }) {
      // One statement for any list of types. julianday, so "10:00:00Z" is not read as later than "10:00:00.500Z".
      const sql = `SELECT * FROM events WHERE type IN (SELECT value FROM json_each(?)) AND target = ? AND julianday(at) >= julianday(?) ORDER BY seq LIMIT ?`;
      return (stmt(sql).all(JSON.stringify(types), target, since, limit) as Row[]).map(toEvent);
    },

    runs({ target, ticket }) {
      const starts = [target != null && "target = ?", ticket != null && "ticket = ?"].filter(Boolean);
      const sql = `SELECT seq, run, target, ticket, at, step, type, data FROM events
        WHERE +type IN ('run_start','run_end','usage','step_start','step_end','review_finding','decision') -- "+" stops SQLite scanning the type index; the run index is better
          AND run IN (SELECT run FROM events WHERE type = 'run_start'${starts.map((c) => ` AND ${c}`).join("")})
        ORDER BY seq`;
      const rows = stmt(sql).all(...[target, ticket].filter((v) => v != null)) as Row[];
      const byRun = new Map<string, RunSummary>();
      for (const r of rows) {
        const id = r.run as string;
        const data = JSON.parse(r.data as string) as Record<string, unknown>;
        let s = byRun.get(id);
        if (r.type === "run_start") {
          s = { run: id, target: r.target as string, ticket: r.ticket as string, startedAt: r.at as string, costUsd: 0 };
          byRun.set(id, s);
        } else if (!s) continue;
        else if (r.type === "run_end") {
          s.endedAt = r.at as string;
          s.outcome = data.outcome as string;
        } else if (r.type === "usage") s.costUsd += data.costUsd as number;
        else if (r.type === "step_start" || r.type === "step_end") s.lastStep = trackStep(s.lastStep, { type: r.type, step: text(r.step), at: r.at as string });
        else if (r.type === "review_finding") s.round = Math.max(s.round ?? 0, data.round as number);
        else if (r.type === "decision") {
          if (typeof data.risk === "number") s.mergeRisk = data.risk;
          if (typeof data.riskMax === "number") s.mergeRiskMax = data.riskMax;
          if (typeof data.changeUrl === "string") s.changeUrl = data.changeUrl;
        }
      }
      return [...byRun.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
    },

    switches(target) {
      const rows = db.prepare(`SELECT scope, name, "on" FROM switches WHERE scope IN (?, '*')`).all(target) as Row[];
      const out = Object.fromEntries(SWITCHES.map((n) => [n, true])) as Record<SwitchName, boolean>;
      for (const r of rows) if (!r.on) out[r.name as SwitchName] = false;
      return out;
    },

    setSwitch(scope, name, on, user) {
      const at = new Date().toISOString();
      inTransaction(() => {
        db.prepare(`INSERT INTO switches (scope, name, "on", user, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (scope, name) DO UPDATE SET "on" = excluded."on", user = excluded.user, at = excluded.at`).run(scope, name, on ? 1 : 0, user, at);
        // A switch change belongs to no run, so run and ticket stay empty.
        insertEvents([{ id: randomUUID(), run: "", at, target: scope, ticket: "", type: "switch_change", data: { user, name, scope, on } }]);
      });
    },

    request(r) {
      return inTransaction(() => {
        const v = view(r.run);
        if (!v) return { refused: "run not found" };
        const why = v.refusals[r.kind];
        if (why) return { refused: why };
        const row: ControlRequest = { id: randomUUID(), at: new Date().toISOString(), kind: r.kind, run: r.run, target: r.target, ticket: r.ticket, user: r.user };
        db.prepare("INSERT INTO requests (id, kind, run, target, ticket, user, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(row.id, row.kind, row.run, row.target, row.ticket, row.user, row.at);
        insertEvents([{ id: randomUUID(), run: r.run, at: row.at, target: r.target, ticket: r.ticket, type: r.kind, data: { user: r.user } }]);
        return row;
      });
    },

    ended,
    view,

    requests({ target, pending, sinceMinutes }) {
      const since = sinceMinutes == null ? null : new Date(Date.now() - sinceMinutes * 60_000).toISOString();
      const rows = db
        .prepare("SELECT * FROM requests WHERE (? IS NULL OR target = ?) AND (? = 0 OR done_at IS NULL) AND (? IS NULL OR at > ?) ORDER BY at, rowid")
        .all(target ?? null, target ?? null, pending ? 1 : 0, since, since) as Row[];
      return rows.map(toRequest);
    },

    finish(id, outcome) {
      if (outcome === "cancelled") cancelStmt.run(id);
      else finishStmt.run(new Date().toISOString(), outcome, id);
    },

    addDispatch(input) {
      const s: Dispatch = { ...input, id: randomUUID(), at: new Date().toISOString() };
      db.prepare("INSERT INTO dispatches (id, target, source, key, title, details, link, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(s.id, s.target, s.source, s.key, s.title, s.details, s.link ?? null, s.at);
      return s;
    },

    dispatches(target) {
      const rows = db.prepare("SELECT * FROM dispatches WHERE target = ? AND done_at IS NULL ORDER BY at, rowid").all(target) as Row[];
      return rows.map((r) => ({ id: r.id as string, target: r.target as string, source: r.source as string, key: r.key as string, title: r.title as string, details: r.details as string, at: r.at as string, ...(r.link == null ? {} : { link: r.link as string }) }));
    },

    dispatchTargets(startedBefore) {
      const rows = db.prepare("SELECT DISTINCT target FROM dispatches WHERE done_at IS NULL AND (started_at IS NULL OR started_at < ?) ORDER BY target").all(startedBefore) as Row[];
      return rows.map((r) => r.target as string);
    },

    dispatchStarted(target, at) {
      db.prepare("UPDATE dispatches SET started_at = ? WHERE target = ? AND done_at IS NULL").run(at, target);
    },

    dispatchDone(id) {
      db.prepare("UPDATE dispatches SET done_at = ? WHERE id = ? AND done_at IS NULL").run(new Date().toISOString(), id);
    },

    isImported: (job) => db.prepare("SELECT 1 FROM imported_jobs WHERE job = ?").get(job) !== undefined,

    markImported(job) {
      db.prepare("INSERT OR IGNORE INTO imported_jobs (job, at) VALUES (?, ?)").run(job, new Date().toISOString());
    },

    prune(now) {
      const cutoff = new Date(now.getTime() - 90 * DAY_MS).toISOString();
      db.prepare("UPDATE events SET data = json_remove(data, '$.input', '$.result') WHERE type = 'tool_call' AND at < ?").run(cutoff);
    },

    backup(dir, now) {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `factory-${now.toISOString().slice(0, 10)}.db`);
      rmSync(file, { force: true }); // VACUUM INTO refuses to write over a file
      db.prepare("VACUUM INTO ?").run(file);
      const old = readdirSync(dir).filter((f) => BACKUP_FILE.test(f)).sort().slice(0, -KEEP_BACKUPS);
      for (const f of old) rmSync(join(dir, f));
    },
  };
}
