import { formatFromFileName, type LibraryFileFormat } from "@nslib/formats";
import { and, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  applications,
  containerEntries,
  contentMetas,
  contentRecords,
  type FileRow,
  files,
  homebrew,
  libraryRoots,
  type RootRow,
  settings,
} from "../db/schema";
import { type InspectionResult, PARSER_VERSION } from "./inspect";

export interface FileStat {
  size: number;
  mtimeMs: number;
  format?: LibraryFileFormat;
}

export type InspectionOutcome =
  | {
      status: "ok" | "unidentified";
      result: InspectionResult;
      iconKey: string | null;
      message: string | null;
    }
  | { status: "error"; message: string };

export interface ReconcileResult {
  /** File IDs that need (re-)inspection. */
  toParse: number[];
  added: number;
  moved: number;
  missing: number;
  changed: boolean;
}

export interface SeenFileResult {
  fileId: number;
  needsParse: boolean;
  changed: boolean;
}

export interface RootStats {
  rootId: number;
  fileCount: number;
  totalSize: number;
  missingCount: number;
}

const CATALOG_REV_KEY = "catalog_rev";

function baseName(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf("/") + 1);
}

function requireFormat(relPath: string, hint?: LibraryFileFormat) {
  if (hint) return hint;
  const format = formatFromFileName(baseName(relPath));
  if (!format) throw new Error(`Unsupported library file: ${relPath}`);
  return format;
}

function diskColumns(stat: FileStat): { size: number; mtimeMs: number } {
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}

function isStale(row: FileRow): boolean {
  return row.parseStatus === "pending" || row.parserVersion < PARSER_VERSION;
}

export class LibraryRepository {
  readonly db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.#now = now;
  }

  // Roots

  listRoots(): RootRow[] {
    return this.db.select().from(libraryRoots).orderBy(libraryRoots.path).all();
  }

  getRoot(id: number): RootRow | undefined {
    return this.db.select().from(libraryRoots).where(eq(libraryRoots.id, id)).get();
  }

  createRoot(input: { path: string; label?: string | null; usePolling?: boolean }): RootRow {
    return this.db
      .insert(libraryRoots)
      .values({
        path: input.path,
        label: input.label || null,
        usePolling: input.usePolling ?? false,
        createdAt: this.#now(),
      })
      .returning()
      .get();
  }

  updateRoot(
    id: number,
    patch: Partial<Pick<RootRow, "label" | "enabled" | "usePolling">>,
  ): RootRow | undefined {
    if (Object.keys(patch).length === 0) return this.getRoot(id);
    const updated = this.db
      .update(libraryRoots)
      .set(patch)
      .where(eq(libraryRoots.id, id))
      .returning()
      .get();
    if (updated && patch.enabled !== undefined) this.#bumpCatalogRev();
    return updated;
  }

  deleteRoot(id: number): boolean {
    return this.db.transaction(() => {
      const deleted = this.db.delete(libraryRoots).where(eq(libraryRoots.id, id)).run();
      if (deleted.changes > 0) this.#bumpCatalogRev();
      return deleted.changes > 0;
    });
  }

  setRootScanResult(id: number, lastScanError: string | null): void {
    this.db
      .update(libraryRoots)
      .set({ lastScanAt: this.#now(), lastScanError })
      .where(eq(libraryRoots.id, id))
      .run();
  }

  rootStats(): RootStats[] {
    return this.db
      .select({
        rootId: files.rootId,
        fileCount: sql<number>`count(*) filter (where ${files.missingSince} is null)`,
        totalSize: sql<number>`coalesce(sum(${files.size}) filter (where ${files.missingSince} is null), 0)`,
        missingCount: sql<number>`count(*) filter (where ${files.missingSince} is not null)`,
      })
      .from(files)
      .groupBy(files.rootId)
      .all();
  }

  // Files

  listRootFiles(rootId: number): FileRow[] {
    return this.db.select().from(files).where(eq(files.rootId, rootId)).all();
  }

  getFile(id: number): FileRow | undefined {
    return this.db.select().from(files).where(eq(files.id, id)).get();
  }

  /**
   * Applies a full directory walk: updates changed files, detects renames (a vanished file
   * reappearing elsewhere with the same size and mtime keeps its ID), inserts new files, and
   * marks vanished ones missing. Paths under `skippedDirs` could not be read and are left alone.
   */
  reconcileScan(
    rootId: number,
    seen: ReadonlyMap<string, FileStat>,
    skippedDirs: string[] = [],
  ): ReconcileResult {
    return this.db.transaction(() => {
      const now = this.#now();
      const rows = this.listRootFiles(rootId);
      const byPath = new Map(rows.map((row) => [row.relPath, row]));
      const result: ReconcileResult = {
        toParse: [],
        added: 0,
        moved: 0,
        missing: 0,
        changed: false,
      };
      const accounted = new Set<number>();
      const unmatched: [string, FileStat][] = [];

      for (const [relPath, stat] of seen) {
        const row = byPath.get(relPath);
        if (!row) {
          unmatched.push([relPath, stat]);
          continue;
        }
        accounted.add(row.id);
        if (row.size !== stat.size || row.mtimeMs !== stat.mtimeMs) {
          this.db
            .update(files)
            .set({
              ...diskColumns(stat),
              ...(stat.format ? { format: stat.format } : {}),
              parseStatus: "pending",
              missingSince: null,
            })
            .where(eq(files.id, row.id))
            .run();
          result.toParse.push(row.id);
          result.changed = true;
          continue;
        }
        if (row.missingSince !== null) {
          this.db.update(files).set({ missingSince: null }).where(eq(files.id, row.id)).run();
          result.changed = true;
        }
        if (isStale(row)) result.toParse.push(row.id);
      }

      for (const row of rows) {
        if (skippedDirs.some((dir) => row.relPath.startsWith(`${dir}/`))) accounted.add(row.id);
      }
      const vanished = rows.filter((row) => !accounted.has(row.id));

      for (const [relPath, stat] of unmatched) {
        const candidates = vanished.filter(
          (row) => !accounted.has(row.id) && row.size === stat.size && row.mtimeMs === stat.mtimeMs,
        );
        const moved = candidates.length === 1 ? candidates[0] : undefined;
        if (moved) {
          accounted.add(moved.id);
          this.db
            .update(files)
            .set({
              relPath,
              format: requireFormat(relPath, stat.format),
              parseStatus: "pending",
              missingSince: null,
            })
            .where(eq(files.id, moved.id))
            .run();
          result.toParse.push(moved.id);
          result.moved++;
        } else {
          const inserted = this.db
            .insert(files)
            .values({
              rootId,
              relPath,
              format: requireFormat(relPath, stat.format),
              ...diskColumns(stat),
              firstSeenAt: now,
            })
            .returning({ id: files.id })
            .get();
          result.toParse.push(inserted.id);
          result.added++;
        }
        result.changed = true;
      }

      for (const row of vanished) {
        if (accounted.has(row.id) || row.missingSince !== null) continue;
        this.db.update(files).set({ missingSince: now }).where(eq(files.id, row.id)).run();
        result.missing++;
        result.changed = true;
      }

      if (result.changed) this.#bumpCatalogRev();
      return result;
    });
  }

  /** Watcher path: one file appeared or changed. */
  upsertSeenFile(rootId: number, relPath: string, stat: FileStat): SeenFileResult {
    return this.db.transaction(() => {
      const row = this.db
        .select()
        .from(files)
        .where(and(eq(files.rootId, rootId), eq(files.relPath, relPath)))
        .get();

      if (row) {
        const modified = row.size !== stat.size || row.mtimeMs !== stat.mtimeMs;
        if (modified || row.missingSince !== null) {
          this.db
            .update(files)
            .set({
              ...diskColumns(stat),
              ...(stat.format ? { format: stat.format } : {}),
              missingSince: null,
              ...(modified ? { parseStatus: "pending" as const } : {}),
            })
            .where(eq(files.id, row.id))
            .run();
          this.#bumpCatalogRev();
        }
        return {
          fileId: row.id,
          needsParse: modified || isStale(row),
          changed: modified || row.missingSince !== null,
        };
      }

      const candidates = this.db
        .select({ id: files.id })
        .from(files)
        .where(
          and(
            eq(files.rootId, rootId),
            isNotNull(files.missingSince),
            eq(files.size, stat.size),
            eq(files.mtimeMs, stat.mtimeMs),
          ),
        )
        .all();
      const moved = candidates.length === 1 ? candidates[0] : undefined;
      let fileId: number;
      if (moved) {
        this.db
          .update(files)
          .set({
            relPath,
            format: requireFormat(relPath, stat.format),
            parseStatus: "pending",
            missingSince: null,
          })
          .where(eq(files.id, moved.id))
          .run();
        fileId = moved.id;
      } else {
        fileId = this.db
          .insert(files)
          .values({
            rootId,
            relPath,
            format: requireFormat(relPath, stat.format),
            ...diskColumns(stat),
            firstSeenAt: this.#now(),
          })
          .returning({ id: files.id })
          .get().id;
      }
      this.#bumpCatalogRev();
      return { fileId, needsParse: true, changed: true };
    });
  }

  /** Marks a file, or every file under a directory, as missing. Returns the number affected. */
  markMissing(rootId: number, relPath: string, isDirectory: boolean): number {
    const pathMatch = isDirectory
      ? sql`(${files.relPath} = ${relPath} or instr(${files.relPath}, ${`${relPath}/`}) = 1)`
      : eq(files.relPath, relPath);
    const result = this.db
      .update(files)
      .set({ missingSince: this.#now() })
      .where(and(eq(files.rootId, rootId), isNull(files.missingSince), pathMatch))
      .run();
    if (result.changes > 0) this.#bumpCatalogRev();
    return result.changes;
  }

  saveInspection(fileId: number, stat: FileStat | null, outcome: InspectionOutcome): void {
    this.db.transaction(() => {
      this.db.delete(containerEntries).where(eq(containerEntries.fileId, fileId)).run();
      this.db.delete(contentMetas).where(eq(contentMetas.fileId, fileId)).run();
      this.db.delete(homebrew).where(eq(homebrew.fileId, fileId)).run();

      let metadataSource: FileRow["metadataSource"] = null;
      if (outcome.status !== "error") {
        const { result } = outcome;
        if (result.entries.length > 0) {
          this.db
            .insert(containerEntries)
            .values(
              result.entries.map((e) => ({
                fileId,
                name: e.name,
                offset: e.offset,
                size: e.size,
                kind: e.kind,
              })),
            )
            .run();
        }
        if (result.metas.length > 0) {
          for (const meta of result.metas) {
            const inserted = this.db
              .insert(contentMetas)
              .values({
                fileId,
                titleId: meta.titleId,
                version: meta.version,
                type: meta.type,
                applicationId: meta.applicationId,
                applicationIdSource: meta.applicationIdSource,
                displayName: meta.displayName,
                keyGeneration: meta.keyGeneration,
                rightsId: meta.rightsId,
                requiredSystemVersion: meta.requiredSystemVersion,
                installSize: meta.installSize,
                source: meta.source,
              })
              .returning({ id: contentMetas.id })
              .get();
            if (meta.records.length > 0) {
              this.db
                .insert(contentRecords)
                .values(meta.records.map((record) => ({ metaId: inserted.id, ...record })))
                .run();
            }
          }
        }
        if (result.application) {
          const now = this.#now();
          const row = {
            name: result.application.name,
            nameSource: "nacp" as const,
            publisher: result.application.publisher,
            updatedAt: now,
            ...(outcome.iconKey ? { iconKey: outcome.iconKey } : {}),
          };
          this.db
            .insert(applications)
            .values({ applicationId: result.application.applicationId, ...row })
            .onConflictDoUpdate({ target: applications.applicationId, set: row })
            .run();
        }
        if (result.homebrew) {
          const { name, publisher, version } = result.homebrew;
          this.db
            .insert(homebrew)
            .values({ fileId, name, publisher, version, iconKey: outcome.iconKey })
            .run();
        }
        metadataSource = result.metadataSource;
      }

      this.db
        .update(files)
        .set({
          ...(stat ?? {}),
          parseStatus: outcome.status,
          parseError: outcome.message,
          parserVersion: PARSER_VERSION,
          metadataSource,
          verifyStatus: "unverified",
          verifiedAt: null,
        })
        .where(eq(files.id, fileId))
        .run();
      this.#bumpCatalogRev();
    });
  }

  /** Deletes files that have been missing for longer than `maxAgeMs`. */
  purgeMissing(maxAgeMs: number): number {
    const result = this.db
      .delete(files)
      .where(and(isNotNull(files.missingSince), lt(files.missingSince, this.#now() - maxAgeMs)))
      .run();
    if (result.changes > 0) this.#bumpCatalogRev();
    return result.changes;
  }

  /** Forces present files to be re-inspected (e.g. after keys are uploaded). */
  invalidatePresentFiles(): number {
    const result = this.db
      .update(files)
      .set({
        parseStatus: "pending",
        parserVersion: 0,
        verifyStatus: "unverified",
        verifiedAt: null,
      })
      .where(isNull(files.missingSince))
      .run();
    if (result.changes > 0) this.#bumpCatalogRev();
    return result.changes;
  }

  setFileVerify(
    fileId: number,
    verifyStatus: FileRow["verifyStatus"],
    sha256: string | null = null,
  ): void {
    this.db
      .update(files)
      .set({ verifyStatus, verifiedAt: this.#now(), ...(sha256 ? { sha256 } : {}) })
      .where(eq(files.id, fileId))
      .run();
  }

  catalogRev(): number {
    const row = this.db.select().from(settings).where(eq(settings.key, CATALOG_REV_KEY)).get();
    return row ? Number(row.value) : 0;
  }

  #bumpCatalogRev(): void {
    this.db
      .insert(settings)
      .values({ key: CATALOG_REV_KEY, value: "1" })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: sql`cast(cast(${settings.value} as integer) + 1 as text)` },
      })
      .run();
  }
}
