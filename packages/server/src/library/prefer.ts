import type { ContainerFormat } from "@nslib/shared";

const COMPRESSED: Record<ContainerFormat, number> = {
  nsz: 0,
  xcz: 1,
  nsp: 2,
  xci: 3,
  nro: 4,
};

const UNCOMPRESSED: Record<ContainerFormat, number> = {
  nsp: 0,
  xci: 1,
  nsz: 2,
  xcz: 3,
  nro: 4,
};

export function preferredFormatRank(format: ContainerFormat, preferCompressed: boolean): number {
  return (preferCompressed ? COMPRESSED : UNCOMPRESSED)[format];
}

/** Picks NSZ/XCZ over NSP/XCI when `preferCompressed` is set; ties break on the lowest id. */
export function pickPreferred<T extends { format: ContainerFormat; id: number }>(
  items: readonly T[],
  preferCompressed: boolean,
): T {
  const first = items[0];
  if (!first) throw new Error("pickPreferred called with no items");
  return items.reduce((best, item) => {
    const bestRank = preferredFormatRank(best.format, preferCompressed);
    const itemRank = preferredFormatRank(item.format, preferCompressed);
    if (itemRank < bestRank || (itemRank === bestRank && item.id < best.id)) return item;
    return best;
  }, first);
}
