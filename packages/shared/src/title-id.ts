export type ContentMetaType = "application" | "patch" | "addon";

const TITLE_ID_RE = /^[0-9A-F]{16}$/;
const PATCH_BIT = 0x800n;
const ADDON_BIT = 0x1000n;
const LOW_12_BITS = 0xfffn;

export function isTitleId(value: string): boolean {
  return TITLE_ID_RE.test(value);
}

/** Accepts any-case hex with an optional 0x prefix and returns the canonical 16-digit uppercase form. */
export function normalizeTitleId(value: string): string {
  const hex = value.trim().replace(/^0x/i, "").toUpperCase();
  if (!TITLE_ID_RE.test(hex)) {
    throw new Error(`Invalid title ID: ${JSON.stringify(value)}`);
  }
  return hex;
}

export function titleIdToBigInt(titleId: string): bigint {
  return BigInt(`0x${normalizeTitleId(titleId)}`);
}

export function bigIntToTitleId(value: bigint): string {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new Error(`Title ID out of range: ${value}`);
  }
  return value.toString(16).toUpperCase().padStart(16, "0");
}

/**
 * Filename-level guess at the content type: base games end in 000, updates in 800,
 * anything else is DLC. The CNMT is authoritative when keys are available.
 */
export function inferTypeFromTitleId(titleId: string): ContentMetaType {
  const low = titleIdToBigInt(titleId) & LOW_12_BITS;
  if (low === 0n) return "application";
  if (low === PATCH_BIT) return "patch";
  return "addon";
}

export function applicationIdForPatch(patchTitleId: string): string {
  return bigIntToTitleId(titleIdToBigInt(patchTitleId) & ~PATCH_BIT);
}

/** Heuristic DLC → base mapping; only used when neither the NACP nor titledb can answer. */
export function guessApplicationIdForAddon(addonTitleId: string): string {
  return bigIntToTitleId((titleIdToBigInt(addonTitleId) ^ ADDON_BIT) & ~LOW_12_BITS);
}

export interface FilenameInfo {
  titleId?: string;
  version?: number;
}

/** Reads the common `Name [0100XXXXXXXXXXXX][v123456].nsp` naming convention. */
export function parseTitleFilename(fileName: string): FilenameInfo {
  const info: FilenameInfo = {};
  const tid = /\[(0100[0-9A-Fa-f]{12})\]/.exec(fileName);
  if (tid?.[1]) info.titleId = tid[1].toUpperCase();
  const version = /\[v(\d{1,10})\]/i.exec(fileName);
  if (version?.[1]) {
    const n = Number(version[1]);
    if (n <= 0xffffffff) info.version = n;
  }
  return info;
}
