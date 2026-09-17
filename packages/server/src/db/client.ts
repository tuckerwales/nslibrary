import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;

/** Relative to `src/db/` when running from source, and to `dist/` in the built image. */
function migrationsDir(): string {
  const source = fileURLToPath(new URL("../../drizzle", import.meta.url));
  const bundled = fileURLToPath(new URL("../drizzle", import.meta.url));
  return existsSync(join(bundled, "meta", "_journal.json")) ? bundled : source;
}

export const MIGRATIONS_DIR = migrationsDir();

export interface OpenDatabase {
  db: Db;
  sqlite: Database.Database;
}

/** Opens (or creates) the database and applies pending migrations. Use ":memory:" in tests. */
export function openDatabase(file: string, migrationsFolder = MIGRATIONS_DIR): OpenDatabase {
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return { db, sqlite };
}
