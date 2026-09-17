import type { CatalogApp, CatalogResponse, ContainerFormat, ContentMetaType } from "@nslib/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { applications, contentMetas, files, libraryRoots } from "../db/schema";
import { pickPreferred } from "../library/prefer";
import { tdbApp, tdbTitle, titledbJoin } from "../library/titledb-join";

const DEFAULT_LIMIT = 200;

interface CatalogRow {
  metaId: number;
  titleId: string;
  version: number | null;
  type: ContentMetaType;
  applicationId: string;
  displayName: string;
  requiredSystemVersion: number | null;
  fileId: number;
  format: ContainerFormat;
  size: number;
  appName: string | null;
  appPublisher: string | null;
  appIconKey: string | null;
}

function loadRows(db: Db, titledb: boolean): CatalogRow[] {
  const tdb = titledbJoin(titledb);
  return db
    .select({
      metaId: contentMetas.id,
      titleId: contentMetas.titleId,
      version: contentMetas.version,
      type: contentMetas.type,
      applicationId: tdb.applicationId,
      displayName: tdb.displayName,
      requiredSystemVersion: contentMetas.requiredSystemVersion,
      fileId: files.id,
      format: files.format,
      size: files.size,
      appName: tdb.appName,
      appPublisher: tdb.appPublisher,
      appIconKey: applications.iconKey,
    })
    .from(contentMetas)
    .innerJoin(files, eq(files.id, contentMetas.fileId))
    .innerJoin(libraryRoots, eq(libraryRoots.id, files.rootId))
    .leftJoin(tdbTitle, tdb.titleOn)
    .leftJoin(applications, tdb.applicationOn)
    .leftJoin(tdbApp, tdb.appOn)
    .where(and(isNull(files.missingSince), eq(libraryRoots.enabled, true)))
    .all();
}

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

function pickRow(rows: CatalogRow[], preferCompressed: boolean): CatalogRow {
  return pickPreferred(
    rows.map((row) => ({ ...row, format: row.format, id: row.fileId })),
    preferCompressed,
  );
}

function iconRevision(iconKey: string | null): number | null {
  if (!iconKey) return null;
  return Number.parseInt(iconKey.slice(0, 8), 16) >>> 0;
}

function versionOf(row: CatalogRow): number {
  return row.version ?? 0;
}

function toApp(applicationId: string, rows: CatalogRow[], preferCompressed: boolean): CatalogApp {
  const bases = groupBy(
    rows.filter((r) => r.type === "application"),
    (r) => versionOf(r),
  );
  const patches = groupBy(
    rows.filter((r) => r.type === "patch"),
    (r) => versionOf(r),
  );
  const addons = groupBy(
    rows.filter((r) => r.type === "addon"),
    (r) => r.titleId,
  );

  const newestBaseVersion = [...bases.keys()].sort((a, b) => b - a)[0];
  const baseRows = newestBaseVersion === undefined ? undefined : bases.get(newestBaseVersion);
  const base = baseRows ? pickRow(baseRows, preferCompressed) : null;

  const updates = [...patches.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, group]) => pickRow(group, preferCompressed));

  const dlc = [...addons.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, group]) => {
      const newest = [...groupBy(group, (r) => versionOf(r)).entries()].sort((a, b) => b[0] - a[0]);
      const top = newest[0]?.[1];
      return top ? pickRow(top, preferCompressed) : group[0];
    })
    .filter((row): row is CatalogRow => row !== undefined);

  const selected = [base, ...updates, ...dlc].filter((row): row is CatalogRow => row !== null);
  const rsv = selected.reduce<number | undefined>((max, row) => {
    const value = row.requiredSystemVersion;
    if (value == null) return max;
    return max == null || value > max ? value : max;
  }, undefined);

  const first = rows[0];
  return {
    i: applicationId,
    n: first?.appName ?? base?.displayName ?? first?.displayName ?? applicationId,
    ...(first?.appPublisher ? { p: first.appPublisher } : {}),
    ic: iconRevision(first?.appIconKey ?? null),
    ...(rsv !== undefined ? { rsv } : {}),
    b: base ? [versionOf(base), base.metaId, base.size, base.format] : null,
    u: updates.map((row) => [versionOf(row), row.metaId, row.size, row.format]),
    d: dlc.map((row) => [row.titleId, versionOf(row), row.displayName, row.metaId, row.size]),
  };
}

export function buildCatalogApps(db: Db, preferCompressed: boolean, titledb = false): CatalogApp[] {
  const byApp = groupBy(loadRows(db, titledb), (row) => row.applicationId);
  return [...byApp]
    .map(([id, rows]) => toApp(id, rows, preferCompressed))
    .sort((a, b) => a.i.localeCompare(b.i));
}

export function paginateCatalog(
  apps: CatalogApp[],
  rev: number,
  query: { since?: number; cursor?: string; limit?: number },
): CatalogResponse {
  const limit = query.limit ?? DEFAULT_LIMIT;
  if (query.since !== undefined && query.since >= rev) {
    return { rev, full: false, apps: [], del: [], next: null };
  }

  let start = 0;
  const cursor = query.cursor;
  if (cursor) {
    const index = apps.findIndex((app) => app.i > cursor);
    start = index === -1 ? apps.length : index;
  }
  const page = apps.slice(start, start + limit);
  const last = page[page.length - 1];
  const more = start + limit < apps.length;
  return {
    rev,
    full: true,
    apps: page,
    del: [],
    next: more && last ? last.i : null,
  };
}
