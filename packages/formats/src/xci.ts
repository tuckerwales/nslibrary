/**
 * XCI / XCZ cartridge images. Only the `secure` partition holds installable content; the
 * `update` partition carries system updates and is never installed.
 */
import { FormatError, readMagic, readU64 } from "./binary";
import { type Hfs0Entry, type Partition, parseHfs0 } from "./partition";
import { type RandomAccessReader, readExact } from "./reader";

const CARD_HEADER_MAGIC_OFFSET = 0x100;
const ROOT_PARTITION_OFFSET_FIELD = 0x130;
const CARD_HEADER_SIZE = 0x140;
/** Some dumps prepend the 0x1000-byte key area before the card header. */
const KEY_AREA_SIZE = 0x1000;
const KNOWN_PARTITIONS = new Set(["update", "normal", "secure", "logo"]);

export interface XciInfo {
  /** Offset of the card header: 0, or 0x1000 when a key area is prepended. */
  cardOffset: number;
  root: Partition<Hfs0Entry>;
  partitions: Map<string, Partition<Hfs0Entry>>;
  secure: Partition<Hfs0Entry>;
}

async function findCardHeader(reader: RandomAccessReader): Promise<number> {
  for (const candidate of [0, KEY_AREA_SIZE]) {
    if (candidate + CARD_HEADER_SIZE > reader.size) continue;
    const magic = await readExact(reader, candidate + CARD_HEADER_MAGIC_OFFSET, 4);
    if (readMagic(magic, 0, 4) === "HEAD") return candidate;
  }
  throw new FormatError("BAD_MAGIC", "no XCI card header (HEAD) at 0x100 or 0x1100");
}

export async function parseXci(reader: RandomAccessReader): Promise<XciInfo> {
  const cardOffset = await findCardHeader(reader);
  const header = await readExact(reader, cardOffset, CARD_HEADER_SIZE);
  const root = await parseHfs0(reader, cardOffset + readU64(header, ROOT_PARTITION_OFFSET_FIELD));

  const partitions = new Map<string, Partition<Hfs0Entry>>();
  for (const entry of root.entries) {
    if (!KNOWN_PARTITIONS.has(entry.name)) continue;
    // Empty partitions (commonly `logo` or `update` on trimmed dumps) have no header to parse.
    if (entry.size === 0) continue;
    partitions.set(entry.name, await parseHfs0(reader, entry.offset, entry.offset + entry.size));
  }

  const secure = partitions.get("secure");
  if (!secure) throw new FormatError("INVALID", "XCI has no secure partition");
  return { cardOffset, root, partitions, secure };
}
