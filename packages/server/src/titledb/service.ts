/**
 * Optional titledb import: names, DLC base games, latest versions, and the details the library can
 * be sorted and filtered by (release dates, languages, regions, age rating, players). An optional
 * versions list adds when each update came out. Never used as a download source. The data is
 * stored as imported and applied when the library is read (titledb-join.ts), so the enabled switch
 * and refreshes take effect without re-scanning.
 */
import { readFile } from "node:fs/promises";
import { applicationIdForPatch, inferTypeFromTitleId, type TitledbStatus } from "@nslib/shared";
import { eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { settings, titledbTitles, titledbVersions } from "../db/schema";

const SOURCE_KEY = "titledb_source";
const VERSIONS_SOURCE_KEY = "titledb_versions_source";
const ENABLED_KEY = "titledb_enabled";
const REFRESH_KEY = "titledb_last_refresh";
const ERROR_KEY = "titledb_last_error";
/** Rows per multi-row INSERT; keeps well under SQLite's bound-parameter limit. */
const INSERT_BATCH = 500;

/** A field that is dropped, rather than dropping the whole entry, when it's null or malformed. */
const lenient = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

const EntrySchema = z
  .object({
    id: lenient(z.string()),
    name: lenient(z.string()),
    publisher: lenient(z.string()),
    description: lenient(z.string()),
    iconUrl: lenient(z.string()),
    version: lenient(z.number().int().nonnegative()),
    baseId: lenient(z.string()),
    applicationId: lenient(z.string()),
    releaseDate: lenient(z.union([z.number(), z.string()])),
    languages: lenient(z.array(z.string())),
    regions: lenient(z.array(z.string())),
    rating: lenient(z.number().int().min(0).max(99)),
    numberOfPlayers: lenient(z.number().int().min(1).max(99)),
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

/** titledb lists dates as YYYYMMDD or YYYY-MM-DD, as a number or a string. Anything else is dropped. */
export function parseReleaseDate(value: number | string | undefined): number | null {
  if (value === undefined) return null;
  const digits = String(value).trim().replace(/-/g, "");
  if (!/^\d{8}$/.test(digits)) return null;
  const date = Number(digits);
  const month = Math.floor(date / 100) % 100;
  const day = date % 100;
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? date : null;
}

/** Distinct codes, cleaned up and sorted, as stored: a JSON array, or null when there are none. */
function codeList(
  values: string[] | undefined,
  normalize: (code: string) => string,
): string | null {
  const codes = [
    ...new Set(
      (values ?? [])
        .map((value) => normalize(value.trim()))
        .filter((code) => /^[\w-]{1,16}$/.test(code)),
    ),
  ].sort();
  return codes.length > 0 ? JSON.stringify(codes) : null;
}

/**
 * A versions list, like blawar's versions.json: `{ "<title ID>": { "<version>": "YYYY-MM-DD" } }`.
 * Keys may be the game's ID or its update's; both are filed under the game.
 */
export function parseVersionsJson(text: string): Map<string, Map<number, number | null>> {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The versions list must be a JSON object keyed by title ID");
  }
  const byTitle = new Map<string, Map<number, number | null>>();
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const titleId = normalizeTitleId(key);
    if (!titleId || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const appId =
      inferTypeFromTitleId(titleId) === "patch" ? applicationIdForPatch(titleId) : titleId;
    const versions = byTitle.get(appId) ?? new Map<number, number | null>();
    for (const [rawVersion, rawDate] of Object.entries(value as Record<string, unknown>)) {
      if (!/^\d{1,10}$/.test(rawVersion)) continue;
      const date =
        typeof rawDate === "string" || typeof rawDate === "number"
          ? parseReleaseDate(rawDate)
          : null;
      versions.set(Number(rawVersion), date);
    }
    if (versions.size > 0) byTitle.set(appId, versions);
  }
  if (byTitle.size === 0) throw new Error("No versions found in that versions list");
  return byTitle;
}

const isUrl = (source: string) => /^https?:\/\//i.test(source);

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
    const dated =
      this.#db
        .select({ n: sql<number>`count(*)` })
        .from(titledbVersions)
        .where(isNotNull(titledbVersions.releaseDate))
        .get()?.n ?? 0;
    const refresh = setting(this.#db, REFRESH_KEY);
    return {
      enabled: this.enabled(),
      source: setting(this.#db, SOURCE_KEY),
      versionsSource: setting(this.#db, VERSIONS_SOURCE_KEY),
      titleCount: count,
      datedVersionCount: dated,
      lastRefreshAt: refresh ? Number(refresh) : null,
      lastError: setting(this.#db, ERROR_KEY),
    };
  }

  configure(input: {
    enabled?: boolean;
    source?: string | null;
    versionsSource?: string | null;
  }): TitledbStatus {
    if (input.enabled !== undefined) putSetting(this.#db, ENABLED_KEY, input.enabled ? "1" : "0");
    if (input.source !== undefined) putSetting(this.#db, SOURCE_KEY, input.source);
    if (input.versionsSource !== undefined) {
      putSetting(this.#db, VERSIONS_SOURCE_KEY, input.versionsSource);
    }
    return this.status();
  }

  /** Re-imports from the configured sources. Concurrent calls share one import. */
  refresh(): Promise<TitledbStatus> {
    this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  /**
   * Refreshes when titledb is enabled, either source is a URL, and the last refresh is older than
   * `maxAgeMs`. File sources are left to the user, since they change only when replaced. Returns
   * true if an import succeeded.
   */
  async refreshIfStale(maxAgeMs: number): Promise<boolean> {
    const source = setting(this.#db, SOURCE_KEY);
    const versionsSource = setting(this.#db, VERSIONS_SOURCE_KEY);
    if (!this.enabled() || !source) return false;
    if (!isUrl(source) && !(versionsSource && isUrl(versionsSource))) return false;
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
    const versionsSource = setting(this.#db, VERSIONS_SOURCE_KEY);
    try {
      const text = await this.#read(source);
      const versions = versionsSource
        ? parseVersionsJson(await this.#read(versionsSource, "the versions list"))
        : new Map<string, Map<number, number | null>>();
      this.#importJson(text, versions);
      putSetting(this.#db, ERROR_KEY, null);
    } catch (err) {
      putSetting(this.#db, ERROR_KEY, err instanceof Error ? err.message : String(err));
    }
    // Recorded on failure too, so a broken URL isn't retried on every maintenance pass.
    putSetting(this.#db, REFRESH_KEY, String(this.#now()));
    return this.status();
  }

  async #read(source: string, what = "titledb"): Promise<string> {
    if (isUrl(source)) {
      const response = await fetch(source, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`Couldn't download ${what} (${response.status})`);
      return response.text();
    }
    return readFile(source, "utf8");
  }

  #importJson(text: string, versionDates: Map<string, Map<number, number | null>>): void {
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
        releaseDate: parseReleaseDate(entry.data.releaseDate) ?? previous?.releaseDate ?? null,
        languages:
          codeList(entry.data.languages, (code) => code.toLowerCase()) ??
          previous?.languages ??
          null,
        regions:
          codeList(entry.data.regions, (code) => code.toUpperCase()) ?? previous?.regions ?? null,
        rating: entry.data.rating ?? previous?.rating ?? null,
        numberOfPlayers: entry.data.numberOfPlayers ?? previous?.numberOfPlayers ?? null,
        updatedAt: now,
      });
    }
    if (titles.size === 0) throw new Error("No titles found in that titledb file");

    // Every version the versions list dates, plus the latest version from the title's entry. A
    // newer version in the list also counts as the latest known.
    const versions: (typeof titledbVersions.$inferInsert)[] = [];
    for (const row of titles.values()) {
      const dated = new Map(versionDates.get(row.titleId));
      const newestDated = Math.max(-1, ...dated.keys());
      if (newestDated > (row.latestVersion ?? -1)) row.latestVersion = newestDated;
      if (row.latestVersion != null && !dated.has(row.latestVersion)) {
        dated.set(row.latestVersion, null);
      }
      for (const [version, releaseDate] of dated) {
        versions.push({ titleId: row.titleId, version, releaseDate });
      }
    }
    const rows = [...titles.values()];
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
