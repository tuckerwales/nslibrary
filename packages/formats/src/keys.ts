/** Parser for the user's own `prod.keys` (`name = hex` lines). */

export type Keyset = Map<string, Buffer>;

export interface KeysetParseResult {
  keys: Keyset;
  /** 1-based line numbers that were neither blank, comments, nor valid key lines. */
  invalidLines: number[];
}

const KEY_LINE = /^([A-Za-z0-9_]+)\s*=\s*([0-9A-Fa-f]+)$/;

export function parseKeyset(text: string): KeysetParseResult {
  const keys: Keyset = new Map();
  const invalidLines: number[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) return;
    const match = KEY_LINE.exec(line);
    if (!match?.[1] || !match[2] || match[2].length % 2 !== 0) {
      invalidLines.push(index + 1);
      return;
    }
    keys.set(match[1].toLowerCase(), Buffer.from(match[2], "hex"));
  });
  return { keys, invalidLines };
}
