/**
 * Optional titledb import: names, descriptions, latest versions. Never used as a download source.
 */
import { readFile } from "node:fs/promises";
import type { TitledbStatus } from "@nslib/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { applications, settings, titledbTitles, titledbVersions } from "../db/schema";

const SOURCE_KEY = "titledb_source";
const ENABLED_KEY = "titledb_enabled";
const REFRESH_KEY = "titledb_last_refresh";
const ERROR_KEY = "titledb_last_error";

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

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  status(): TitledbStatus {
    const count = this.#db
      .select({ titleId: titledbTitles.titleId })
      .from(titledbTitles)
      .all().length;
    const refresh = setting(this.#db, REFRESH_KEY);
    return {
      enabled: setting(this.#db, ENABLED_KEY) !== "0",
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

  async refresh(): Promise<TitledbStatus> {
    const source = setting(this.#db, SOURCE_KEY);
    if (!source) {
      putSetting(this.#db, ERROR_KEY, "Set a titledb URL or file path first.");
      return this.status();
    }
    try {
      const text = await this.#read(source);
      this.#importJson(text);
      putSetting(this.#db, REFRESH_KEY, String(this.#now()));
      putSetting(this.#db, ERROR_KEY, null);
    } catch (err) {
      putSetting(this.#db, ERROR_KEY, err instanceof Error ? err.message : String(err));
    }
    return this.status();
  }

  async #read(source: string): Promise<string> {
    if (/^https?:\/\//i.test(source)) {
      const response = await fetch(source, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Couldn't download titledb (${response.status})`);
      return response.text();
    }
    return readFile(source, "utf8");
  }

  #importJson(text: string): void {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Titledb must be a JSON object keyed by title ID");
    }
    const now = this.#now();
    this.#db.transaction(() => {
      this.#db.delete(titledbVersions).run();
      this.#db.delete(titledbTitles).run();
      for (const [rawId, rawEntry] of Object.entries(parsed as Record<string, unknown>)) {
        const titleId = normalizeTitleId(rawId);
        if (!titleId) continue;
        const entry = EntrySchema.safeParse(rawEntry);
        if (!entry.success) continue;
        const applicationId = normalizeTitleId(entry.data.applicationId ?? entry.data.baseId ?? "");
        this.#db
          .insert(titledbTitles)
          .values({
            titleId,
            name: entry.data.name ?? null,
            publisher: entry.data.publisher ?? null,
            description: entry.data.description ?? null,
            iconUrl: entry.data.iconUrl ?? null,
            latestVersion: entry.data.version ?? null,
            applicationId,
            updatedAt: now,
          })
          .run();
        if (entry.data.version != null) {
          this.#db.insert(titledbVersions).values({ titleId, version: entry.data.version }).run();
        }
        this.#fillApplication(titleId, entry.data, now);
      }
    });
  }

  #fillApplication(titleId: string, entry: z.infer<typeof EntrySchema>, now: number): void {
    if (!titleId.endsWith("000") || !entry.name) return;
    const existing = this.#db
      .select()
      .from(applications)
      .where(eq(applications.applicationId, titleId))
      .get();
    if (existing?.nameSource === "nacp") {
      this.#db
        .update(applications)
        .set({
          latestKnownVersion: entry.version ?? existing.latestKnownVersion,
          latestVersionSource: entry.version != null ? "titledb" : existing.latestVersionSource,
          description: existing.description ?? entry.description ?? null,
          updatedAt: now,
        })
        .where(eq(applications.applicationId, titleId))
        .run();
      return;
    }
    this.#db
      .insert(applications)
      .values({
        applicationId: titleId,
        name: entry.name,
        nameSource: "titledb",
        publisher: entry.publisher ?? null,
        description: entry.description ?? null,
        latestKnownVersion: entry.version ?? null,
        latestVersionSource: entry.version != null ? "titledb" : null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: applications.applicationId,
        set: {
          name: entry.name,
          nameSource: "titledb",
          publisher: entry.publisher ?? null,
          description: entry.description ?? null,
          latestKnownVersion: entry.version ?? null,
          latestVersionSource: entry.version != null ? "titledb" : null,
          updatedAt: now,
        },
      })
      .run();
  }
}
