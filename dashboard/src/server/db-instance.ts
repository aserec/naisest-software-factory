import { dirname, join } from "node:path";
import { openDb, type Db } from "./db";

let db: Db | undefined;

// Opened on first use, so tests can set DASHBOARD_DB=":memory:" before they call it.
export function getDb(): Db {
  return (db ??= openDb(dbPath()));
}

const dbPath = () => process.env.DASHBOARD_DB ?? "/data/factory.db";

// BACKUP_DIR, else a backups folder next to the database (/data/backups in production).
export const backupDir = () => process.env.BACKUP_DIR ?? join(dirname(dbPath()), "backups");
