import { deterministicBytes } from "./bytes";
import { buildHfs0, type FixtureFile, partitionHeaderSize } from "./partition";

export const XCI_ROOT_PARTITION_OFFSET = 0xf000;

export interface XciBuildOptions {
  /** Prepend a 0x1000-byte key area before the card header. */
  keyArea?: boolean;
  update?: FixtureFile[];
  normal?: FixtureFile[];
  /** Include an empty `logo` partition entry, as on newer cartridges. */
  emptyLogo?: boolean;
  /** Leave out the secure partition (for negative tests). */
  omitSecure?: boolean;
}

export function buildXci(secure: FixtureFile[], options: XciBuildOptions = {}): Buffer {
  const partitions: FixtureFile[] = [
    { name: "update", data: buildHfs0(options.update ?? []) },
    { name: "normal", data: buildHfs0(options.normal ?? []) },
  ];
  if (!options.omitSecure) partitions.push({ name: "secure", data: buildHfs0(secure) });
  if (options.emptyLogo) partitions.push({ name: "logo", data: new Uint8Array(0) });
  const root = buildHfs0(partitions);

  const card = Buffer.alloc(XCI_ROOT_PARTITION_OFFSET);
  deterministicBytes("xci:signature", 0x100).copy(card, 0);
  card.write("HEAD", 0x100, "latin1");
  card.writeBigUInt64LE(BigInt(XCI_ROOT_PARTITION_OFFSET), 0x130);
  card.writeBigUInt64LE(BigInt(partitionHeaderSize(root)), 0x138);

  const image = Buffer.concat([card, root]);
  return options.keyArea
    ? Buffer.concat([deterministicBytes("xci:key-area", 0x1000), image])
    : image;
}
