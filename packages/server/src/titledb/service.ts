/**
 * Optional titledb import: names, DLC base games, and latest versions. Never used as a download
 * source. The data is stored as imported and applied when the library is read (titledb-join.ts),
 * so the enabled switch and refreshes take effect without re-scanning.
 */
import { readFile } from "node:fs/promises";
import type { TitledbStatus } from "@nslib/shared";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { settings, titledbTitles, titledbVersions } from "../db/schema";

const SOURCE_KEY = "titledb_source";
const ENABLED_KEY = "titledb_enabled";
const REFRESH_KEY = "titledb_last_refresh";
const ERROR_KEY = "titledb_last_error";
/** Rows per multi-row INSERT; keeps well under SQLite's bound-parameter limit. */
const INSERT_BATCH = 500;

const EntrySchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    publisher: z.string().optional(),
    description: z.string().optional(),
    iconUrl: z.string().optional(),
    version: z.number().int().nonnegative().optional(),
    baseId: z.string().optional(),
    applicationId: z.string().optional(),
  })
  .passthrough();

function setting(db: Db, key: string): string | null {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null;
}

function putSetting(db: Db, key: string, value: string | null): void {
  if (value === null) {
    db.delete(settings).where(eq(settings.key, key)).run();
    return;
  }
  db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}

function normalizeTitleId(value: string): string | null {
  const hex = value.trim().replace(/^0x/i, "").toUpperCase();
  return /^[0-9A-F]{16}$/.test(hex) ? hex : null;
}

export class TitledbService {
  readonly #db: Db;
  readonly #now: () => number;
  #refreshing: Promise<TitledbStatus> | null = null;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  /** Whether titledb data is applied to the library. On unless turned off. */
  enabled(): boolean {
    return setting(this.#db, ENABLED_KEY) !== "0";
  }

  status(): TitledbStatus {
    const count = this.#db.select({ n: sql<number>`count(*)` }).from(titledbTitles).get()?.n ?? 0;
    const refresh = setting(this.#db, REFRESH_KEY);
    return {
      enabled: this.enabled(),
      source: setting(this.#db, SOURCE_KEY),
      titleCount: count,
      lastRefreshAt: refresh ? Number(refresh) : null,
      lastError: setting(this.#db, ERROR_KEY),
    };
  }

  configure(input: { enabled?: boolean; source?: string | null }): TitledbStatus {
    if (input.enabled !== undefined) putSetting(this.#db, ENABLED_KEY, input.enabled ? "1" : "0");
    if (input.source !== undefined) putSetting(this.#db, SOURCE_KEY, input.source);
    return this.status();
  }

  /** Re-imports from the configured source. Concurrent calls share one import. */
  refresh(): Promise<TitledbStatus> {
    this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  /**
   * Refreshes a URL source that is enabled and older than `maxAgeMs`. File sources are left to
   * the user, since they change only when replaced. Returns true if an import succeeded.
   */
  async refreshIfStale(maxAgeMs: number): Promise<boolean> {
    const source = setting(this.#db, SOURCE_KEY);
    if (!this.enabled() || !source || !/^https?:\/\//i.test(source)) return false;
    const last = Number(setting(this.#db, REFRESH_KEY) ?? 0);
    if (this.#now() - last < maxAgeMs) return false;
    const status = await this.refresh();
    return status.lastError === null;
  }

  async #refresh(): Promise<TitledbStatus> {
    const source = setting(this.#db, SOURCE_KEY);
    if (!source) {
      putSetting(this.#db, ERROR_KEY, "Set a titledb URL or file path first.");
      return this.status();
    }
    try {
      const text = await this.#read(source);
      this.#importJson(text);
      putSetting(this.#db, ERROR_KEY, null);
    } catch (err) {
      putSetting(this.#db, ERROR_KEY, err instanceof Error ? err.message : String(err));
    }
    // Recorded on failure too, so a broken URL isn't retried on every maintenance pass.
    putSetting(this.#db, REFRESH_KEY, String(this.#now()));
    return this.status();
  }

  async #read(source: string): Promise<string> {
    if (/^https?:\/\//i.test(source)) {
      const response = await fetch(source, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`Couldn't download titledb (${response.status})`);
      return response.text();
    }
    return readFile(source, "utf8");
  }

  #importJson(text: string): void {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Titledb must be a JSON object keyed by title ID or eShop ID");
    }
    const now = this.#now();
    const titles = new Map<string, typeof titledbTitles.$inferInsert>();
    for (const [key, rawEntry] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = EntrySchema.safeParse(rawEntry);
      if (!entry.success) continue;
      // Keyed by title ID, or (like blawar's titledb) by eShop ID with the title ID in `id`.
      const titleId = normalizeTitleId(key) ?? normalizeTitleId(entry.data.id ?? "");
      if (!titleId) continue;
      const previous = titles.get(titleId);
      // Region files list a title once per eShop ID; keep the entry with the most detail.
      if (previous?.name && !entry.data.name) continue;
      titles.set(titleId, {
        titleId,
        name: entry.data.name ?? null,
        publisher: entry.data.publisher ?? null,
        description: entry.data.description ?? null,
        iconUrl: entry.data.iconUrl ?? null,
        latestVersion: entry.data.version ?? previous?.latestVersion ?? null,
        applicationId: normalizeTitleId(entry.data.applicationId ?? entry.data.baseId ?? ""),
        updatedAt: now,
      });
    }
    if (titles.size === 0) throw new Error("No titles found in that titledb file");

    const rows = [...titles.values()];
    const versions = rows.flatMap((row) =>
      row.latestVersion == null ? [] : [{ titleId: row.titleId, version: row.latestVersion }],
    );
    this.#db.transaction(() => {
      this.#db.delete(titledbVersions).run();
      this.#db.delete(titledbTitles).run();
      for (let i = 0; i < rows.length; i += INSERT_BATCH) {
        this.#db
          .insert(titledbTitles)
          .values(rows.slice(i, i + INSERT_BATCH))
          .run();
      }
      for (let i = 0; i < versions.length; i += INSERT_BATCH) {
        this.#db
          .insert(titledbVersions)
          .values(versions.slice(i, i + INSERT_BATCH))
          .run();
      }
    });
  }
}
