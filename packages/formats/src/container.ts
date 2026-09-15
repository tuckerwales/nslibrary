import type { PartitionEntry } from "./partition";
import { parsePfs0 } from "./partition";
import type { RandomAccessReader } from "./reader";
import { parseXci } from "./xci";

export type ContainerFormat = "nsp" | "nsz" | "xci" | "xcz";
export type LibraryFileFormat = ContainerFormat | "nro";

const EXTENSIONS: Record<string, LibraryFileFormat> = {
  ".nsp": "nsp",
  ".nsz": "nsz",
  ".xci": "xci",
  ".xcz": "xcz",
  ".nro": "nro",
};

export function formatFromFileName(fileName: string): LibraryFileFormat | null {
  const dot = fileName.lastIndexOf(".");
  if (dot === -1) return null;
  return EXTENSIONS[fileName.slice(dot).toLowerCase()] ?? null;
}

/** Lists installable entries: the PFS0 root for NSP/NSZ, the secure partition for XCI/XCZ. */
export async function listContainerEntries(
  reader: RandomAccessReader,
  format: ContainerFormat,
): Promise<PartitionEntry[]> {
  switch (format) {
    case "nsp":
    case "nsz":
      return (await parsePfs0(reader)).entries;
    case "xci":
    case "xcz":
      return (await parseXci(reader)).secure.entries;
  }
}
