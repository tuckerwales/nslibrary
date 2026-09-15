/**
 * Parser for the user's own `prod.keys` (`name = hex` lines). Values are never logged; callers
 * should treat a Keyset as secret and only report key *names* over an API.
 */
import { FormatError } from "./binary";
import { aesEcb } from "./crypto";

export type Keyset = Map<string, Buffer>;

export interface KeysetParseResult {
  keys: Keyset;
  /** 1-based line numbers that were neither blank, comments, nor valid key lines. */
  invalidLines: number[];
}

export class MissingKeyError extends Error {
  readonly keyName: string;

  constructor(keyName: string) {
    super(`Missing ${keyName} in prod.keys`);
    this.name = "MissingKeyError";
    this.keyName = keyName;
  }
}

const KEY_LINE = /^([A-Za-z0-9_]+)\s*=\s*([0-9A-Fa-f]+)$/;
const KAEK_KIND = ["application", "ocean", "system"] as const;

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

export function generationSuffix(generation: number): string {
  return generation.toString(16).padStart(2, "0");
}

/** Master-key index used with `key_area_key_*_XX` / `titlekek_XX`. Generations 0 and 1 both use 00. */
export function masterKeyIndex(keyGeneration: number): number {
  return keyGeneration <= 1 ? 0 : keyGeneration - 1;
}

export function kaekName(kaekIndex: number, generation: number): string {
  const kind = KAEK_KIND[kaekIndex];
  if (!kind) throw new FormatError("INVALID", `unknown key-area key index ${kaekIndex}`);
  return `key_area_key_${kind}_${generationSuffix(generation)}`;
}

export function titlekekName(generation: number): string {
  return `titlekek_${generationSuffix(generation)}`;
}

export function requireKey(keys: Keyset, name: string, expectedLength?: number): Buffer {
  const value = keys.get(name.toLowerCase());
  if (!value) throw new MissingKeyError(name);
  if (expectedLength !== undefined && value.length !== expectedLength) {
    throw new FormatError(
      "INVALID",
      `${name} is ${value.length} bytes, expected ${expectedLength}`,
    );
  }
  return value;
}

export function headerKey(keys: Keyset): Buffer {
  return requireKey(keys, "header_key", 32);
}

export function keyAreaKey(keys: Keyset, kaekIndex: number, keyGeneration: number): Buffer {
  const index = masterKeyIndex(keyGeneration);
  return requireKey(keys, kaekName(kaekIndex, index), 16);
}

export function titlekek(keys: Keyset, keyGeneration: number): Buffer {
  return requireKey(keys, titlekekName(masterKeyIndex(keyGeneration)), 16);
}

/** Decrypts the 0x40 NCA key area with the matching key-area key. */
export function unwrapKeyArea(
  keys: Keyset,
  encryptedKeyArea: Buffer,
  kaekIndex: number,
  keyGeneration: number,
): Buffer {
  if (encryptedKeyArea.length !== 0x40) {
    throw new FormatError("INVALID", `key area is ${encryptedKeyArea.length} bytes, expected 0x40`);
  }
  return aesEcb(keyAreaKey(keys, kaekIndex, keyGeneration), encryptedKeyArea, false);
}

/** Common (not personalized) title key: AES-ECB(titlekek, first 16 bytes of the ticket block). */
export function decryptTitleKey(
  keys: Keyset,
  titleKeyBlock: Buffer,
  keyGeneration: number,
): Buffer {
  if (titleKeyBlock.length < 16) {
    throw new FormatError("TRUNCATED", "title key block is shorter than 16 bytes");
  }
  return aesEcb(titlekek(keys, keyGeneration), titleKeyBlock.subarray(0, 16), false);
}

export interface KeysetStatus {
  configured: boolean;
  names: string[];
  headerKey: boolean;
  keyAreaKeyGenerations: number[];
  titlekekGenerations: number[];
}

/** Reports which key *names* are present. Never includes key material. */
export function keysetStatus(keys: Keyset | null): KeysetStatus {
  if (!keys || keys.size === 0) {
    return {
      configured: false,
      names: [],
      headerKey: false,
      keyAreaKeyGenerations: [],
      titlekekGenerations: [],
    };
  }
  const names = [...keys.keys()].sort();
  const generations = (prefix: string) => {
    const found: number[] = [];
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const suffix = name.slice(prefix.length);
      if (!/^[0-9a-f]{2}$/.test(suffix)) continue;
      found.push(Number.parseInt(suffix, 16));
    }
    return found.sort((a, b) => a - b);
  };
  return {
    configured: keys.has("header_key"),
    names,
    headerKey: keys.has("header_key"),
    keyAreaKeyGenerations: generations("key_area_key_application_"),
    titlekekGenerations: generations("titlekek_"),
  };
}
