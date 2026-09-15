import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

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
