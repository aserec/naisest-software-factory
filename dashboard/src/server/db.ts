import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { z } from "zod";
import { defaultSwitches, type AgentPlan, type planProposal, type PlanState, type ControlRequest, type EventType, type RunEvent, type Dispatch, type DispatchInput, type SwitchName, type TargetSettings, type UsageLimits } from "software-factory/run-events";
import { labelState, runView, trackStep, type RunView } from "./run-view";
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
  conflicts?: boolean; // the change has conflicts with the base branch, from change_state; a later decision means the round resolved them
}

// A state the factory set on a work item, from its label_change event.
export interface StateChange { run: string; target: string; ticket: string; at: string; state: FactoryState }

// How often the factory resolved a work item's conflicts: a conflict round that reached its decision.
export interface Resolutions { target: string; ticket: string; count: number; last: string }

// A dispatch with what became of it, for the dispatches page.
export interface DispatchLog extends Dispatch { startedAt?: string; doneAt?: string; workItem?: string }
export interface SwitchChange { at: string; user: string; name: SwitchName; scope: string; on: boolean }

/** A message in the chat of a page (path). author: a username or "agent". plan: the plan the message proposes. */
export interface ChatMessage { seq: number; path: string; author: string; at: string; text: string; plan?: AgentPlan }

export interface Db {
  addEvents(events: RunEvent[]): number;
  events(q: { run?: string; after?: number; limit?: number }): { events: (RunEvent & { seq: number })[]; cursor: number };
  /** Events of the target at or after `since` with one of the types, oldest first. */
  history(q: { target: string; since: string; types: EventType[]; limit: number }): RunEvent[];
  /** The newest events of the types across every target, newest first. */
  recent(q: { types: EventType[]; limit: number }): (RunEvent & { seq: number })[];
  /** The plan's usage windows from the newest usage event that carries them, with when it was sent. */
  latestLimits(): { at: string; limits: UsageLimits } | undefined;
  runs(q: { target?: string; ticket?: string }): RunSummary[];
  /** The newest run of each work item given, by when it was saved; a work item with no run is left out. */
  latestRuns(items: { target: string; ticket: string }[]): RunSummary[];
  /** Every state the factory set on the work items given, across all their runs, oldest first. */
  stateChanges(items: { target: string; ticket: string }[]): StateChange[];
  /** Per work item given, the conflict rounds that reached a decision, across all its runs; a work item with none is left out. */
  resolutions(items: { target: string; ticket: string }[]): Resolutions[];
  /** The work item's events of the types, across all its runs, oldest first. */
  itemEvents(item: { target: string; ticket: string }, types: EventType[]): RunEvent[];
  /** The CI run (pipeline field) of the run's newest step_start, or undefined when that step_start names none. */
  newestPipeline(run: string): string | undefined;
  switches(target: string): Record<SwitchName, boolean>;
  setSwitch(scope: string, name: SwitchName, on: boolean, user: string): void;
  /** The newest switch changes first, from their switch_change events. */
  switchChanges(limit: number): SwitchChange[];
  /** The target's Settings page values as stored, raw; empty thresholds when none. Checked by the factory and the settings route. */
  settings(target: string): TargetSettings & { user?: string; at?: string };
  /** Saves the target's settings and its settings_change audit event in one transaction. */
  setSettings(target: string, s: TargetSettings, user: string): void;
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
  /** workItem: the url of the work item the dispatch opened. */
  dispatchDone(id: string, workItem?: string): void;
  /** Every dispatch of the target, done or not, newest first. */
  dispatchLog(target: string, limit: number): DispatchLog[];
  /** Targets with a waiting dispatch whose run was never started, or last started before `startedBefore`. */
  dispatchTargets(startedBefore: string): string[];
  dispatchStarted(target: string, at: string): void;
  isImported(job: string): boolean;
  markImported(job: string): void;
  /** The user's saved preferences as stored, {} when none. Checked by preferences.ts, not here. */
  preferences(user: string): Record<string, unknown>;
  setPreferences(user: string, prefs: Record<string, unknown>): void;
  /** The newest `limit` messages of the path, oldest first, each with its plan. */
  chat(path: string, limit: number): ChatMessage[];
  /** With a plan, stores it as proposed for planUser (whose question led to it) in the same transaction. */
  addChatMessage(m: { path: string; author: string; text: string; plan?: z.infer<typeof planProposal>; planUser?: string }): ChatMessage;
  /** Only from proposed. */
  approvePlan(id: string, user: string): AgentPlan | { refused: string };
  /** Oldest first. */
  approvedPlans(): AgentPlan[];
  /** Only approved to running, and running to done or failed; any other move gives undefined. A move adds an agent message to the plan's path. */
  updatePlan(id: string, state: "running" | "done" | "failed", result?: string): AgentPlan | undefined;
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
  details TEXT NOT NULL, link TEXT, at TEXT NOT NULL, started_at TEXT, done_at TEXT, work_item TEXT
);
CREATE INDEX IF NOT EXISTS dispatches_pending ON dispatches (target, done_at, at);
CREATE TABLE IF NOT EXISTS imported_jobs (job TEXT PRIMARY KEY, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS preferences (user TEXT PRIMARY KEY, data TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (target TEXT PRIMARY KEY, data TEXT NOT NULL, user TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chat_messages (seq INTEGER PRIMARY KEY, path TEXT NOT NULL, author TEXT NOT NULL, at TEXT NOT NULL, text TEXT NOT NULL, plan TEXT);
CREATE INDEX IF NOT EXISTS chat_messages_path ON chat_messages (path, seq);
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY, path TEXT NOT NULL, data TEXT NOT NULL, state TEXT NOT NULL, user TEXT NOT NULL, at TEXT NOT NULL, approved_by TEXT, result TEXT
);`;

const DAY_MS = 864e5;
const KEEP_BACKUPS = 7;
const BACKUP_FILE = /^factory-\d{4}-\d{2}-\d{2}\.db$/;

type Row = Record<string, unknown>;

function toEvent(r: Row): RunEvent & { seq: number } {
  // Stored rows are untyped. runEvent checked them when they came in, so the type and data are taken as they are.
  const e = { seq: r.seq as number, id: r.id as string, run: r.run as string, at: r.at as string, target: r.target as string, ticket: r.ticket as string, type: r.type as EventType, data: JSON.parse(r.data as string) } as RunEvent & { seq: number };
  for (const k of ["parent", "pipeline", "job", "step"] as const) if (r[k] != null) e[k] = r[k] as string;
  return e;
}

const toDispatch = (r: Row): Dispatch => ({ id: r.id as string, target: r.target as string, source: r.source as string, key: r.key as string, title: r.title as string, details: r.details as string, at: r.at as string, ...(r.link == null ? {} : { link: r.link as string }) });

function toRequest(r: Row): ControlRequest {
  const q: ControlRequest = { id: r.id as string, kind: r.kind as ControlRequest["kind"], run: r.run as string, target: r.target as string, ticket: r.ticket as string, user: r.user as string, at: r.at as string };
  if (r.outcome != null) q.outcome = r.outcome as ControlRequest["outcome"];
  if (r.done_at != null) q.doneAt = r.done_at as string;
  return q;
}

function toPlan(r: Row): AgentPlan {
  const p: AgentPlan = { id: r.id as string, path: r.path as string, ...(JSON.parse(r.data as string) as Pick<AgentPlan, "repo" | "target" | "summary" | "steps">), state: r.state as PlanState, user: r.user as string, at: r.at as string };
  if (r.approved_by != null) p.approvedBy = r.approved_by as string;
  if (r.result != null) p.result = r.result as string;
  return p;
}

export const EVENTS_SQL = (run: boolean) => `SELECT * FROM events WHERE seq > ?${run ? " AND run = ?" : ""} ORDER BY seq LIMIT ?`;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  // A database from before work_item has the table without it; CREATE TABLE IF NOT EXISTS does not add it.
  if (!db.prepare("SELECT 1 FROM pragma_table_info('dispatches') WHERE name = 'work_item'").get()) db.exec("ALTER TABLE dispatches ADD COLUMN work_item TEXT");

  const insertEvent = db.prepare("INSERT OR IGNORE INTO events (id, run, parent, at, target, ticket, pipeline, job, step, type, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  // A pending request is one with no done_at. "cancelled" keeps it pending, so the poller still sees the stop, and is never overwritten.
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
    // The poller acts on the work item, not the run, so only the work item's newest run may be acted on.
    const newer = db.prepare("SELECT 1 FROM events WHERE type = 'run_start' AND target = ? AND ticket = ? AND run != ? AND seq > (SELECT MIN(seq) FROM events WHERE run = ? AND type = 'run_start')").get(first.target as string, first.ticket as string, run, run) !== undefined;
    const requests = (db.prepare("SELECT * FROM requests WHERE run = ? ORDER BY at, rowid").all(run) as Row[]).map(toRequest);
    return runView({ events: (viewEvents.all(run) as Row[]).map(toEvent), requests, newer, ...o });
  }

  // Run summaries of the runs `runSql` selects (one column of run ids), newest first.
  function summaries(runSql: string, params: SQLInputValue[]): RunSummary[] {
    const sql = `SELECT seq, id, run, target, ticket, at, step, type, data FROM events
      WHERE +type IN ('run_start','run_end','usage','step_start','step_end','review_finding','decision','change_state') -- "+" stops SQLite scanning the type index; the run index is better
        AND run IN (${runSql})
      ORDER BY seq`;
    const rows = stmt(sql).all(...params) as Row[];
    const byRun = new Map<string, RunSummary>();
    for (const r of rows) {
      const e = toEvent(r);
      const id = e.run;
      let s = byRun.get(id);
      if (e.type === "run_start") {
        s = { run: id, target: e.target, ticket: e.ticket, startedAt: e.at, costUsd: 0 };
        byRun.set(id, s);
      } else if (!s) continue;
      else if (e.type === "run_end") {
        s.endedAt = e.at;
        s.outcome = e.data.outcome;
      } else if (e.type === "usage") s.costUsd += e.data.costUsd;
      else if (e.type === "step_start" || e.type === "step_end") s.lastStep = trackStep(s.lastStep, e);
      else if (e.type === "review_finding") s.round = Math.max(s.round ?? 0, e.data.round);
      else if (e.type === "decision") {
        if (e.data.risk !== undefined) s.mergeRisk = e.data.risk;
        if (e.data.riskMax !== undefined) s.mergeRiskMax = e.data.riskMax;
        if (e.data.changeUrl !== undefined) s.changeUrl = e.data.changeUrl;
        if (s.conflicts) s.conflicts = false;
      } else if (e.type === "change_state") s.conflicts = e.data.conflicts;
    }
    return [...byRun.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
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

  const planById = (id: string) => {
    const r = db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as Row | undefined;
    return r && toPlan(r);
  };
  const toMessage = (r: Row): ChatMessage => {
    const m: ChatMessage = { seq: r.seq as number, path: r.path as string, author: r.author as string, at: r.at as string, text: r.text as string };
    const plan = r.plan == null ? undefined : planById(r.plan as string);
    if (plan) m.plan = plan;
    return m;
  };
  // Call inside a transaction.
  function insertMessage(path: string, author: string, text: string, plan?: string): ChatMessage {
    const at = new Date().toISOString();
    const r = db.prepare("INSERT INTO chat_messages (path, author, at, text, plan) VALUES (?, ?, ?, ?, ?)").run(path, author, at, text, plan ?? null);
    return toMessage({ seq: Number(r.lastInsertRowid), path, author, at, text, plan });
  }
  // Each move is one UPDATE guarded by the old state, so of two racing callers only one sees changes = 1.
  const MOVES = { running: "approved", done: "running", failed: "running" } as const;
  const FIX_TEXT = { running: () => "Fix started.", done: (r?: string) => `Fix done: ${r ?? ""}`, failed: (r?: string) => `Fix failed: ${r ?? ""}` };

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

    recent({ types, limit }) {
      const sql = `SELECT * FROM events WHERE type IN (SELECT value FROM json_each(?)) ORDER BY seq DESC LIMIT ?`;
      return (stmt(sql).all(JSON.stringify(types), limit) as Row[]).map(toEvent);
    },

    latestLimits() {
      // ponytail: walks usage events newest first until one has limits; an index on it if pi-only runs pile up.
      const r = stmt("SELECT at, data ->> '$.limits' AS limits FROM events WHERE type = 'usage' AND data ->> '$.limits' IS NOT NULL ORDER BY seq DESC LIMIT 1").get() as { at: string; limits: string } | undefined;
      return r && { at: r.at, limits: JSON.parse(r.limits) };
    },

    runs({ target, ticket }) {
      const starts = [target != null && "target = ?", ticket != null && "ticket = ?"].filter(Boolean);
      return summaries(`SELECT run FROM events WHERE type = 'run_start'${starts.map((c) => ` AND ${c}`).join("")}`, [target, ticket].filter((v) => v != null));
    },

    latestRuns(items) {
      const newest = "SELECT (SELECT run FROM events WHERE type = 'run_start' AND target = j.value ->> 0 AND ticket = j.value ->> 1 ORDER BY seq DESC LIMIT 1) FROM json_each(?) j";
      return summaries(newest, [JSON.stringify(items.map((i) => [i.target, i.ticket]))]);
    },

    stateChanges(items) {
      const sql = "SELECT run, target, ticket, at, data FROM events WHERE type = 'label_change' AND (target, ticket) IN (SELECT j.value ->> 0, j.value ->> 1 FROM json_each(?) j) ORDER BY at, seq";
      return (stmt(sql).all(JSON.stringify(items.map((i) => [i.target, i.ticket]))) as Row[]).flatMap((r) => {
        const state = labelState((JSON.parse(r.data as string) as { to: string }).to);
        return state ? [{ run: r.run as string, target: r.target as string, ticket: r.ticket as string, at: r.at as string, state }] : [];
      });
    },

    resolutions(items) {
      const sql = "SELECT run, target, ticket, at, type, data FROM events WHERE type IN ('change_state', 'decision') AND (target, ticket) IN (SELECT j.value ->> 0, j.value ->> 1 FROM json_each(?) j) ORDER BY at, seq";
      const open = new Set<string>(); // runs whose conflict round has not reached its decision yet
      const out = new Map<string, Resolutions>();
      for (const r of stmt(sql).all(JSON.stringify(items.map((i) => [i.target, i.ticket]))) as Row[]) {
        const run = r.run as string;
        if (r.type === "change_state") {
          if ((JSON.parse(r.data as string) as { conflicts: boolean }).conflicts) open.add(run);
        } else if (open.delete(run)) {
          const key = `${r.target}#${r.ticket}`;
          const n = out.get(key) ?? { target: r.target as string, ticket: r.ticket as string, count: 0, last: "" };
          out.set(key, { ...n, count: n.count + 1, last: r.at as string });
        }
      }
      return [...out.values()];
    },

    itemEvents({ target, ticket }, types) {
      const sql = `SELECT seq, id, run, target, ticket, at, step, type, data FROM events WHERE target = ? AND ticket = ? AND type IN (SELECT value FROM json_each(?)) ORDER BY at, seq`;
      return (stmt(sql).all(target, ticket, JSON.stringify(types)) as Row[]).map(toEvent);
    },

    newestPipeline(run) {
      const r = stmt("SELECT pipeline FROM events WHERE run = ? AND type = 'step_start' ORDER BY seq DESC LIMIT 1").get(run) as Row | undefined;
      return (r?.pipeline as string | null | undefined) ?? undefined;
    },

    switches(target) {
      const rows = db.prepare(`SELECT scope, name, "on" FROM switches WHERE scope IN (?, '*')`).all(target) as Row[];
      const out = defaultSwitches();
      // A saved on turns on a switch that starts off. A saved off in either row still wins.
      for (const r of rows) if (r.on) out[r.name as SwitchName] = true;
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

    settings(target) {
      const r = db.prepare("SELECT data, user, at FROM settings WHERE target = ?").get(target) as Row | undefined;
      if (!r) return { thresholds: {} };
      return { ...(JSON.parse(r.data as string) as TargetSettings), user: r.user as string, at: r.at as string };
    },

    setSettings(target, s, user) {
      const at = new Date().toISOString();
      const value: TargetSettings = { thresholds: s.thresholds, ...(s.factoryFile ? { factoryFile: s.factoryFile } : {}) };
      inTransaction(() => {
        db.prepare("INSERT INTO settings (target, data, user, at) VALUES (?, ?, ?, ?) ON CONFLICT (target) DO UPDATE SET data = excluded.data, user = excluded.user, at = excluded.at").run(target, JSON.stringify(value), user, at);
        insertEvents([{ id: randomUUID(), run: "", at, target, ticket: "", type: "settings_change", data: { user, ...value } }]);
      });
    },

    switchChanges(limit) {
      const rows = db.prepare("SELECT at, data FROM events WHERE type = 'switch_change' ORDER BY seq DESC LIMIT ?").all(limit) as Row[];
      return rows.map((r) => ({ at: r.at as string, ...(JSON.parse(r.data as string) as Omit<SwitchChange, "at">) }));
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
      return rows.map(toDispatch);
    },

    dispatchLog(target, limit) {
      const rows = db.prepare("SELECT * FROM dispatches WHERE target = ? ORDER BY at DESC, rowid DESC LIMIT ?").all(target, limit) as Row[];
      return rows.map((r) => ({ ...toDispatch(r), ...(r.started_at == null ? {} : { startedAt: r.started_at as string }), ...(r.done_at == null ? {} : { doneAt: r.done_at as string }), ...(r.work_item == null ? {} : { workItem: r.work_item as string }) }));
    },

    dispatchTargets(startedBefore) {
      const rows = db.prepare("SELECT DISTINCT target FROM dispatches WHERE done_at IS NULL AND (started_at IS NULL OR started_at < ?) ORDER BY target").all(startedBefore) as Row[];
      return rows.map((r) => r.target as string);
    },

    dispatchStarted(target, at) {
      db.prepare("UPDATE dispatches SET started_at = ? WHERE target = ? AND done_at IS NULL").run(at, target);
    },

    dispatchDone(id, workItem) {
      db.prepare("UPDATE dispatches SET done_at = ?, work_item = ? WHERE id = ? AND done_at IS NULL").run(new Date().toISOString(), workItem ?? null, id);
    },

    preferences(user) {
      const r = db.prepare("SELECT data FROM preferences WHERE user = ?").get(user) as Row | undefined;
      return r ? (JSON.parse(r.data as string) as Record<string, unknown>) : {};
    },

    setPreferences(user, prefs) {
      db.prepare("INSERT INTO preferences (user, data, at) VALUES (?, ?, ?) ON CONFLICT (user) DO UPDATE SET data = excluded.data, at = excluded.at").run(user, JSON.stringify(prefs), new Date().toISOString());
    },

    isImported: (job) => db.prepare("SELECT 1 FROM imported_jobs WHERE job = ?").get(job) !== undefined,

    markImported(job) {
      db.prepare("INSERT OR IGNORE INTO imported_jobs (job, at) VALUES (?, ?)").run(job, new Date().toISOString());
    },

    chat(path, limit) {
      const rows = db.prepare("SELECT * FROM (SELECT * FROM chat_messages WHERE path = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq").all(path, limit) as Row[];
      return rows.map(toMessage);
    },

    addChatMessage({ path, author, text, plan, planUser }) {
      return inTransaction(() => {
        let id: string | undefined;
        if (plan) {
          id = randomUUID();
          const { repo, target, summary, steps } = plan;
          db.prepare("INSERT INTO plans (id, path, data, state, user, at) VALUES (?, ?, ?, 'proposed', ?, ?)").run(id, path, JSON.stringify({ repo, ...(target ? { target } : {}), summary, steps }), planUser ?? author, new Date().toISOString());
        }
        return insertMessage(path, author, text, id);
      });
    },

    approvePlan(id, user) {
      const r = db.prepare("UPDATE plans SET state = 'approved', approved_by = ? WHERE id = ? AND state = 'proposed'").run(user, id);
      return r.changes ? planById(id)! : { refused: planById(id) ? "plan is not waiting for approval" : "plan not found" };
    },

    approvedPlans() {
      return (db.prepare("SELECT * FROM plans WHERE state = 'approved' ORDER BY at, rowid").all() as Row[]).map(toPlan);
    },

    updatePlan(id, state, result) {
      return inTransaction(() => {
        const r = db.prepare("UPDATE plans SET state = ?, result = ? WHERE id = ? AND state = ?").run(state, result ?? null, id, MOVES[state]);
        if (!r.changes) return undefined;
        const plan = planById(id)!;
        insertMessage(plan.path, "agent", FIX_TEXT[state](result));
        return plan;
      });
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
