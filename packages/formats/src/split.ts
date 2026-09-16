import { type ContainerFormat, formatFromFileName, type LibraryFileFormat } from "./container";

/** FAT32 dumpers split a container into `00`, `01`, … parts (two decimal digits). */
const PART_NAME = /^\d{2}$/;
/** `Game.nsp.00` next to `Game.nsp.01` in the same folder. */
const NUMBERED_FILE = /^(.+)\.(\d{2})$/;

export interface SplitPart {
  /** File name inside the directory, or the numbered file name (`Game.nsp.00`). */
  name: string;
  index: number;
}

export interface SplitLayout {
  format: ContainerFormat;
  /** Library identity: the directory name, or the stem (`Game.nsp`). */
  relName: string;
  parts: SplitPart[];
}

export function splitPartIndex(name: string): number | null {
  if (!PART_NAME.test(name)) return null;
  return Number(name);
}

export function parseNumberedSplitName(
  name: string,
): { stem: string; index: number; format: ContainerFormat } | null {
  const match = NUMBERED_FILE.exec(name);
  if (!match?.[1] || match[2] === undefined) return null;
  const format = formatFromFileName(match[1]);
  if (format === null || format === "nro") return null;
  return { stem: match[1], index: Number(match[2]), format };
}

export function isSplitRelatedFileName(name: string): boolean {
  return splitPartIndex(name) !== null || parseNumberedSplitName(name) !== null;
}

function consecutiveFromZero(indexes: number[]): boolean {
  if (indexes.length === 0) return false;
  const unique = [...new Set(indexes)].sort((a, b) => a - b);
  if (unique[0] !== 0) return false;
  for (let i = 0; i < unique.length; i++) {
    if (unique[i] !== i) return false;
  }
  return true;
}

function containerFormatFromName(name: string): ContainerFormat | null {
  const format = formatFromFileName(name);
  if (format === null || format === "nro") return null;
  return format;
}

/**
 * A directory is a split container when it holds sequential `00`, `01`, … files.
 * The directory name should carry a container extension (`.nsp`, `.nsz`, `.xci`, `.xcz`).
 */
export function detectSplitDirectory(
  dirName: string,
  entries: ReadonlyArray<{ name: string; isFile: boolean }>,
): SplitLayout | null {
  const format = containerFormatFromName(dirName);
  if (!format) return null;
  const parts: SplitPart[] = [];
  for (const entry of entries) {
    if (!entry.isFile || entry.name.startsWith(".")) continue;
    const index = splitPartIndex(entry.name);
    if (index === null) continue;
    parts.push({ name: entry.name, index });
  }
  parts.sort((a, b) => a.index - b.index);
  if (!consecutiveFromZero(parts.map((p) => p.index))) return null;
  return { format, relName: dirName, parts };
}

/** Groups `Game.nsp.00` / `Game.nsp.01` siblings in one directory into split layouts. */
export function groupNumberedSplitFiles(fileNames: readonly string[]): SplitLayout[] {
  const groups = new Map<string, { format: ContainerFormat; parts: SplitPart[] }>();
  for (const name of fileNames) {
    const parsed = parseNumberedSplitName(name);
    if (!parsed) continue;
    const group = groups.get(parsed.stem) ?? { format: parsed.format, parts: [] };
    group.parts.push({ name, index: parsed.index });
    groups.set(parsed.stem, group);
  }
  const layouts: SplitLayout[] = [];
  for (const [relName, group] of groups) {
    group.parts.sort((a, b) => a.index - b.index);
    if (!consecutiveFromZero(group.parts.map((p) => p.index))) continue;
    layouts.push({ format: group.format, relName, parts: group.parts });
  }
  return layouts;
}

export function isLibraryOrSplitName(name: string): boolean {
  if (name.startsWith(".")) return false;
  if (formatFromFileName(name) !== null) return true;
  return isSplitRelatedFileName(name);
}

export type { LibraryFileFormat };
