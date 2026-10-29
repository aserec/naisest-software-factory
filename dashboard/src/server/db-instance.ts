import { openDb, type Db } from "./db";

let db: Db | undefined;

// Opened on first use, so tests can set DASHBOARD_DB=":memory:" before they call it.
export function getDb(): Db {
  return (db ??= openDb(process.env.DASHBOARD_DB ?? "/data/factory.db"));
}
