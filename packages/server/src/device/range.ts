/** Inclusive byte range. */
export interface ByteRange {
  start: number;
  end: number;
}

export type ParsedRange = ByteRange | "all" | "unsatisfiable";

/**
 * Parses a single HTTP Range. Multipart ranges are rejected. Suffix ranges (`bytes=-500`)
 * and open-ended ranges (`bytes=9500-`) are supported.
 */
export function parseRangeHeader(header: string | undefined, size: number): ParsedRange {
  if (header === undefined || header === "") return "all";
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith("bytes=")) return "unsatisfiable";
  const spec = trimmed.slice(6);
  if (spec.includes(",") || spec.includes(" ")) return "unsatisfiable";

  const suffix = /^-\d+$/.exec(spec);
  if (suffix) {
    const length = Number(spec.slice(1));
    if (length === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - length), end: size - 1 };
  }

  const bounded = /^(\d+)-(\d+)$/.exec(spec);
  if (bounded?.[1] !== undefined && bounded[2] !== undefined) {
    const start = Number(bounded[1]);
    const end = Number(bounded[2]);
    if (start >= size || start > end) return "unsatisfiable";
    return { start, end: Math.min(end, size - 1) };
  }

  const open = /^(\d+)-$/.exec(spec);
  if (open?.[1] !== undefined) {
    const start = Number(open[1]);
    if (start >= size) return "unsatisfiable";
    return { start, end: size - 1 };
  }

  return "unsatisfiable";
}

export function etagFor(size: number, mtimeMs: number): string {
  return `"${size.toString(16)}-${mtimeMs.toString(16)}"`;
}

export function etagsMatch(a: string, b: string): boolean {
  const norm = (value: string) => value.trim().replace(/^W\//, "");
  return norm(a) === norm(b);
}
