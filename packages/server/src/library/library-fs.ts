import { opendir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  detectSplitDirectory,
  formatFromFileName,
  groupNumberedSplitFiles,
  type LibraryFileFormat,
  parseNumberedSplitName,
  splitPartIndex,
} from "@nslib/formats";
import { type ClosableReader, ConcatFileReader, FileHandleReader } from "./file-reader";
import type { FileStat } from "./repository";

export interface LocatedLibraryFile {
  /** First part, or the single file. Useful for logs. */
  absolutePath: string;
  parts: { path: string; size: number }[];
  size: number;
  mtimeMs: number;
  format: LibraryFileFormat;
}

async function dirEntries(absDir: string): Promise<Array<{ name: string; isFile: boolean }>> {
  const dir = await opendir(absDir);
  const entries: Array<{ name: string; isFile: boolean }> = [];
  for await (const entry of dir) {
    entries.push({
      name: entry.name,
      isFile: entry.isFile() || entry.isSymbolicLink(),
    });
  }
  return entries;
}

async function partsFromLayout(
  absDir: string,
  names: string[],
): Promise<{ parts: { path: string; size: number }[]; size: number; mtimeMs: number }> {
  const parts: { path: string; size: number }[] = [];
  let size = 0;
  let mtimeMs = 0;
  for (const name of names) {
    const path = join(absDir, name);
    const info = await stat(path);
    if (!info.isFile()) continue;
    parts.push({ path, size: info.size });
    size += info.size;
    mtimeMs = Math.max(mtimeMs, Math.floor(info.mtimeMs));
  }
  return { parts, size, mtimeMs };
}

/** Maps a watcher path (possibly a `00` part) to the library identity relative path. */
export function libraryIdentityRelPath(relPath: string): string {
  const base = basename(relPath);
  const parent = dirname(relPath);
  const parentRel = parent === "." ? "" : parent;
  if (splitPartIndex(base) !== null && parentRel) return parentRel;
  const numbered = parseNumberedSplitName(base);
  if (numbered) return parentRel ? `${parentRel}/${numbered.stem}` : numbered.stem;
  return relPath;
}

export async function locateOnDisk(
  rootPath: string,
  relPath: string,
): Promise<LocatedLibraryFile | null> {
  const abs = join(rootPath, ...relPath.split("/"));
  const formatFromPath = formatFromFileName(basename(relPath));
  try {
    const info = await stat(abs);
    if (info.isFile()) {
      if (!formatFromPath) return null;
      return {
        absolutePath: abs,
        parts: [{ path: abs, size: info.size }],
        size: info.size,
        mtimeMs: Math.floor(info.mtimeMs),
        format: formatFromPath,
      };
    }
    if (info.isDirectory()) {
      const entries = await dirEntries(abs);
      const split = detectSplitDirectory(basename(relPath), entries);
      if (!split) return null;
      const located = await partsFromLayout(
        abs,
        split.parts.map((p) => p.name),
      );
      const first = located.parts[0];
      if (!first) return null;
      return {
        absolutePath: first.path,
        ...located,
        format: split.format,
      };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const parentAbs = join(
    rootPath,
    ...dirname(relPath)
      .split("/")
      .filter((p) => p && p !== "."),
  );
  const stem = basename(relPath);
  try {
    const entries = await dirEntries(parentAbs);
    const layouts = groupNumberedSplitFiles(entries.filter((e) => e.isFile).map((e) => e.name));
    const layout = layouts.find((item) => item.relName === stem);
    if (!layout) return null;
    const located = await partsFromLayout(
      parentAbs,
      layout.parts.map((p) => p.name),
    );
    const first = located.parts[0];
    if (!first) return null;
    return {
      absolutePath: first.path,
      ...located,
      format: layout.format,
    };
  } catch {
    return null;
  }
}

export async function openLocatedFile(located: LocatedLibraryFile): Promise<ClosableReader> {
  const first = located.parts[0];
  if (located.parts.length === 1 && first) return FileHandleReader.open(first.path);
  return ConcatFileReader.open(located.parts.map((p) => p.path));
}

export function fileStatFromLocated(located: LocatedLibraryFile): FileStat {
  return { size: located.size, mtimeMs: located.mtimeMs, format: located.format };
}
