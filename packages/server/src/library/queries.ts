/** Read models for the web UI, computed from content metas of present files in enabled roots. */
import {
  type AppContent,
  type AppDetail,
  type AppFlag,
  type AppSummary,
  type DuplicateGroup,
  type HomebrewItem,
  type LibraryFileInfo,
  type LibraryStats,
  type ProblemsReport,
  WEB_API_BASE_PATH,
} from "@nslib/shared";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { applications, contentMetas, files, homebrew, libraryRoots } from "../db/schema";
import { preferredFormatRank } from "./prefer";
import { tdbApp, tdbTitle, titledbJoin } from "./titledb-join";

const fileInfoColumns = {
  id: files.id,
  rootId: files.rootId,
  relPath: files.relPath,
  format: files.format,
  size: files.size,
  parseStatus: files.parseStatus,
  parseError: files.parseError,
  metadataSource: files.metadataSource,
  verifyStatus: files.verifyStatus,
  missingSince: files.missingSince,
};

const TYPE_ORDER = { application: 0, patch: 1, addon: 2 } as const;
const nameCollator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export function iconUrl(key: string | null): string | null {
  return key ? `${WEB_API_BASE_PATH}/icons/${key}` : null;
}

interface LoadOptions {
  applicationId?: string;
  /** Apply the title database (see titledb-join.ts). */
  titledb?: boolean;
}

function loadContentRows(db: Db, options: LoadOptions = {}) {
  const tdb = titledbJoin(options.titledb ?? false);
  return db
    .select({
      metaId: contentMetas.id,
      titleId: contentMetas.titleId,
      version: contentMetas.version,
      type: contentMetas.type,
      applicationId: tdb.applicationId,
      applicationIdSource: tdb.applicationIdSource,
      displayName: tdb.displayName,
      keyGeneration: contentMetas.keyGeneration,
      requiredSystemVersion: contentMetas.requiredSystemVersion,
      installSize: contentMetas.installSize,
      file: fileInfoColumns,
      appName: tdb.appName,
      appPublisher: tdb.appPublisher,
      appIconKey: applications.iconKey,
      latestKnownVersion: tdb.latestKnownVersion,
    })
    .from(contentMetas)
    .innerJoin(files, eq(files.id, contentMetas.fileId))
    .innerJoin(libraryRoots, eq(libraryRoots.id, files.rootId))
    .leftJoin(tdbTitle, tdb.titleOn)
    .leftJoin(applications, tdb.applicationOn)
    .leftJoin(tdbApp, tdb.appOn)
    .where(
      and(
        isNull(files.missingSince),
        eq(libraryRoots.enabled, true),
        options.applicationId ? sql`${tdb.applicationId} = ${options.applicationId}` : undefined,
      ),
    )
    .all();
}

type ContentRow = ReturnType<typeof loadContentRows>[number];

const contentKey = (row: { titleId: string; version: number | null }) =>
  `${row.titleId}:${row.version ?? "?"}`;

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group) group.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

function uniqueFiles(rows: ContentRow[]): LibraryFileInfo[] {
  return [...new Map(rows.map((row) => [row.file.id, row.file])).values()];
}

/** The row a "Send to Switch" would install: the preferred format, then the lowest file id. */
function pickPreferredRow(group: ContentRow[], preferCompressed: boolean): ContentRow {
  const first = group[0];
  if (!first) throw new Error("content group is empty");
  return group.reduce((best, row) => {
    const bestRank = preferredFormatRank(best.file.format, preferCompressed);
    const rowRank = preferredFormatRank(row.file.format, preferCompressed);
    if (rowRank < bestRank || (rowRank === bestRank && row.file.id < best.file.id)) return row;
    return best;
  }, first);
}

function summarize(applicationId: string, rows: ContentRow[]): AppSummary {
  const bases = rows.filter((r) => r.type === "application");
  const patches = rows.filter((r) => r.type === "patch");
  const addons = rows.filter((r) => r.type === "addon");
  const allFiles = uniqueFiles(rows);
  const first = rows[0];

  const flags: AppFlag[] = [];
  if (bases.length === 0) flags.push("no-base");
  const byContent = groupBy(rows, contentKey);
  if ([...byContent.values()].some((group) => new Set(group.map((r) => r.file.id)).size > 1)) {
    flags.push("duplicate");
  }
  const updateVersions = [
    ...new Set(patches.flatMap((r) => (r.version === null ? [] : [r.version]))),
  ].sort((a, b) => b - a);
  if (updateVersions.length > 1) flags.push("superseded-updates");
  if (rows.some((r) => r.applicationIdSource === "guess")) flags.push("guessed-dlc-base");
  if (patches.some((r) => r.version === null)) flags.push("unknown-version");
  const latestKnown = first?.latestKnownVersion;
  const newestOwned = updateVersions[0] ?? bases[0]?.version ?? null;
  if (latestKnown != null && newestOwned != null && latestKnown > newestOwned) {
    flags.push("update-available");
  }

  // Filename-derived names: prefer the base game's file, then updates, then DLC.
  const nameSource = bases[0] ?? patches[0] ?? addons[0];
  return {
    applicationId,
    name: first?.appName ?? nameSource?.displayName ?? applicationId,
    publisher: first?.appPublisher ?? null,
    iconUrl: iconUrl(first?.appIconKey ?? null),
    hasBase: bases.length > 0,
    // Sorted: the row order out of SQLite is not stable for rows that tie on the sort key, and an
    // API field that reorders between identical requests churns the UI and breaks snapshot tests.
    baseFormats: [...new Set(bases.map((r) => r.file.format))].sort(),
    updateVersions,
    addonCount: new Set(addons.map((r) => r.titleId)).size,
    fileCount: allFiles.length,
    totalSize: allFiles.reduce((sum, file) => sum + file.size, 0),
    flags,
  };
}

export interface ListApplicationsOptions {
  q?: string;
  flag?: AppFlag;
  titledb?: boolean;
}

function summarizeAll(db: Db, titledb: boolean): AppSummary[] {
  const byApp = groupBy(loadContentRows(db, { titledb }), (row) => row.applicationId);
  return [...byApp].map(([id, rows]) => summarize(id, rows));
}

export function listApplications(db: Db, options: ListApplicationsOptions = {}): AppSummary[] {
  const rows = loadContentRows(db, { titledb: options.titledb });
  const byApp = groupBy(rows, (row) => row.applicationId);
  const needle = options.q?.trim().toLowerCase();

  return [...byApp]
    .filter(([id, appRows]) => {
      if (!needle) return true;
      const upper = needle.toUpperCase();
      return (
        id.includes(upper) ||
        appRows.some(
          (r) => r.titleId.includes(upper) || r.displayName.toLowerCase().includes(needle),
        ) ||
        (appRows[0]?.appName ?? "").toLowerCase().includes(needle)
      );
    })
    .map(([id, appRows]) => summarize(id, appRows))
    .filter((app) => !options.flag || app.flags.includes(options.flag))
    .sort(
      (a, b) =>
        nameCollator.compare(a.name, b.name) || a.applicationId.localeCompare(b.applicationId),
    );
}

export function getApplication(
  db: Db,
  applicationId: string,
  options: { preferCompressed?: boolean; titledb?: boolean } = {},
): AppDetail | null {
  const preferCompressed = options.preferCompressed ?? true;
  const rows = loadContentRows(db, { applicationId, titledb: options.titledb });
  if (rows.length === 0) return null;

  const contents: AppContent[] = [...groupBy(rows, contentKey).values()].map((group) => {
    const head = pickPreferredRow(group, preferCompressed);
    return {
      contentMetaId: head.metaId,
      titleId: head.titleId,
      type: head.type,
      version: head.version,
      name: head.displayName,
      applicationIdSource: head.applicationIdSource,
      keyGeneration: group.find((r) => r.keyGeneration !== null)?.keyGeneration ?? null,
      requiredSystemVersion:
        group.find((r) => r.requiredSystemVersion !== null)?.requiredSystemVersion ?? null,
      installSize: group.find((r) => r.installSize !== null)?.installSize ?? null,
      files: uniqueFiles(group).sort((a, b) => a.relPath.localeCompare(b.relPath)),
    };
  });

  contents.sort(
    (a, b) =>
      TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
      (b.version ?? -1) - (a.version ?? -1) ||
      nameCollator.compare(a.name, b.name) ||
      a.titleId.localeCompare(b.titleId),
  );

  return { ...summarize(applicationId, rows), contents };
}

export function listHomebrew(db: Db): HomebrewItem[] {
  return db
    .select({
      fileId: homebrew.fileId,
      name: homebrew.name,
      publisher: homebrew.publisher,
      version: homebrew.version,
      iconKey: homebrew.iconKey,
      relPath: files.relPath,
      size: files.size,
    })
    .from(homebrew)
    .innerJoin(files, eq(files.id, homebrew.fileId))
    .innerJoin(libraryRoots, eq(libraryRoots.id, files.rootId))
    .where(and(isNull(files.missingSince), eq(libraryRoots.enabled, true)))
    .all()
    .map(({ iconKey, ...item }) => ({ ...item, iconUrl: iconUrl(iconKey) }))
    .sort((a, b) => nameCollator.compare(a.name, b.name));
}

export function getProblems(db: Db, titledb = false): ProblemsReport {
  const fileRows = db
    .select(fileInfoColumns)
    .from(files)
    .innerJoin(libraryRoots, eq(libraryRoots.id, files.rootId))
    .where(eq(libraryRoots.enabled, true))
    .orderBy(asc(files.relPath))
    .all();

  const present = fileRows.filter((f) => f.missingSince === null);
  const duplicates: DuplicateGroup[] = [];
  for (const group of groupBy(loadContentRows(db, { titledb }), contentKey).values()) {
    const groupFiles = uniqueFiles(group);
    const head = group[0];
    if (groupFiles.length < 2 || !head) continue;
    duplicates.push({
      titleId: head.titleId,
      version: head.version,
      name: head.displayName,
      applicationId: head.applicationId,
      files: groupFiles,
    });
  }
  duplicates.sort((a, b) => nameCollator.compare(a.name, b.name));

  return {
    unreadable: present.filter((f) => f.parseStatus === "error"),
    unidentified: present.filter((f) => f.parseStatus === "unidentified"),
    missing: fileRows.filter((f) => f.missingSince !== null),
    duplicates,
  };
}

export function getStats(
  db: Db,
  catalogRev: number,
  options: { keysConfigured?: boolean; titledb?: boolean } = {},
): LibraryStats {
  const titledb = options.titledb ?? false;
  const presentFiles = db
    .select({ size: files.size })
    .from(files)
    .innerJoin(libraryRoots, eq(libraryRoots.id, files.rootId))
    .where(and(isNull(files.missingSince), eq(libraryRoots.enabled, true)))
    .all();
  const problems = getProblems(db, titledb);
  return {
    applications: summarizeAll(db, titledb).length,
    files: presentFiles.length,
    totalSize: presentFiles.reduce((sum, f) => sum + f.size, 0),
    homebrew: listHomebrew(db).length,
    problems:
      problems.unreadable.length +
      problems.unidentified.length +
      problems.missing.length +
      problems.duplicates.length,
    keysConfigured: options.keysConfigured ?? false,
    catalogRev,
  };
}
