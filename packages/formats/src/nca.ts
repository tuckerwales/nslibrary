/**
 * NCA3: decrypt the 0xC00 header with Nintendo AES-XTS, unwrap the key area, decrypt
 * sections with AES-CTR, and open the inner PFS0 (meta) or RomFS (control).
 */
import { createHash } from "node:crypto";
import { FormatError, hex, readMagic, readTitleId, readU64 } from "./binary";
import { type CnmtInfo, parseCnmt } from "./cnmt";
import { aesCtrAt, nintendoXtsCrypt, XTS_SECTOR_SIZE } from "./crypto";
import { headerKey, type Keyset, MissingKeyError, unwrapKeyArea } from "./keys";
import { type NacpInfo, parseNacp } from "./nro";
import { parsePfs0 } from "./partition";
import { BufferReader, type RandomAccessReader, readExact } from "./reader";
import { parseRomfs, readRomfsFile } from "./romfs";

export const NCA_HEADER_SIZE = 0xc00;
const MEDIA_UNIT = XTS_SECTOR_SIZE;
const FS_HEADER_SIZE = 0x200;
const MAX_SECTIONS = 4;

export const NcaContentType = {
  Program: 0,
  Meta: 1,
  Control: 2,
  Manual: 3,
  Data: 4,
  PublicData: 5,
} as const;

export const NcaFsType = {
  RomFs: 0,
  PartitionFs: 1,
} as const;

export const NcaHashType = {
  HierarchicalSha256: 2,
  HierarchicalIntegrity: 3,
} as const;

export const NcaEncryptionType = {
  None: 1,
  AesXts: 2,
  AesCtr: 3,
  AesCtrEx: 4,
} as const;

export interface NcaSection {
  index: number;
  offset: number;
  end: number;
  size: number;
  fsType: number;
  hashType: number;
  encryptionType: number;
  cryptoKey: Buffer | null;
  cryptoCounter: Buffer;
  /** Byte offset of the inner FS within the decrypted section. */
  fsOffset: number;
}

export interface NcaInfo {
  magic: string;
  contentType: number;
  keyGeneration: number;
  kaekIndex: number;
  size: number;
  titleId: string;
  rightsId: string | null;
  sections: NcaSection[];
}

export interface ControlNcaData {
  nacp: NacpInfo;
  /** First icon found (`icon_*.dat`), typically 256×256 JPEG. */
  icon: Buffer | null;
}

export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Filename stem: the first 16 bytes of the NCA's SHA-256, lowercase hex. */
export function ncaIdOf(nca: Buffer): string {
  return sha256Hex(nca).slice(0, 32);
}

function ncaKeyGeneration(header: Buffer): number {
  return Math.max(header.readUInt8(0x206), header.readUInt8(0x220));
}

function parseRightsId(header: Buffer): string | null {
  const raw = header.subarray(0x230, 0x240);
  if (raw.every((b) => b === 0)) return null;
  return raw.toString("hex").toUpperCase();
}

function cryptoCounterFromFsHeader(fsHeader: Buffer): Buffer {
  const raw = Buffer.concat([Buffer.alloc(8), fsHeader.subarray(0x140, 0x148)]);
  return Buffer.from(raw).reverse();
}

function hierarchicalSha256FsOffset(fsHeader: Buffer): number {
  return readU64(fsHeader, 0x40);
}

function ivfcFsOffset(fsHeader: Buffer): number {
  const hashData = fsHeader.subarray(0x8);
  if (readMagic(hashData, 0, 4) !== "IVFC") return 0;
  const maxLayers = hashData.readUInt32LE(0x0c);
  const count = Math.min(maxLayers, 6);
  let offset = 0;
  for (let i = 0; i < count - 1; i++) {
    const o = 0x10 + i * 0x18;
    const size = readU64(hashData, o + 8);
    const blockLog = hashData.readUInt32LE(o + 16);
    const block = blockLog === 0 ? 1 : 2 ** blockLog;
    offset += Math.ceil(size / block) * block;
  }
  return offset;
}

function fsOffsetFor(fsHeader: Buffer): number {
  const hashType = fsHeader.readUInt8(0x3);
  if (hashType === NcaHashType.HierarchicalSha256) return hierarchicalSha256FsOffset(fsHeader);
  if (hashType === NcaHashType.HierarchicalIntegrity) return ivfcFsOffset(fsHeader);
  return 0;
}

export function decryptNcaHeader(encrypted: Buffer, keys: Keyset): Buffer {
  if (encrypted.length < NCA_HEADER_SIZE) {
    throw new FormatError("TRUNCATED", `NCA header is ${hex(encrypted.length)} bytes`);
  }
  return nintendoXtsCrypt(headerKey(keys), encrypted.subarray(0, NCA_HEADER_SIZE), false);
}

export interface NcaParseOptions {
  /**
   * Accept BKTR (AesCtrEx) sections, as patch NCAs use. Their `cryptoCounter` is only the base
   * counter; reading one needs the section's subsection table, so only the NCZ encoder asks.
   */
  allowAesCtrEx?: boolean;
}

export function parseDecryptedNcaHeader(
  header: Buffer,
  keys: Keyset,
  titleKey?: Buffer,
  options: NcaParseOptions = {},
): NcaInfo {
  const magic = readMagic(header, 0x200, 4);
  if (magic === "NCA2" || magic === "NCA1" || magic === "NCA0") {
    throw new FormatError("UNSUPPORTED", `${magic} headers are not supported`);
  }
  if (magic !== "NCA3") {
    throw new FormatError("BAD_MAGIC", `expected NCA3, found ${JSON.stringify(magic)}`);
  }

  const kaekIndex = header.readUInt8(0x207);
  const keyGeneration = ncaKeyGeneration(header);
  const rightsId = parseRightsId(header);

  let sectionKey: Buffer;
  if (rightsId) {
    if (!titleKey) throw new MissingKeyError(`title key for rights ID ${rightsId}`);
    if (titleKey.length !== 16) throw new FormatError("INVALID", "title key must be 16 bytes");
    sectionKey = titleKey;
  } else {
    const keyArea = unwrapKeyArea(keys, header.subarray(0x300, 0x340), kaekIndex, keyGeneration);
    sectionKey = Buffer.from(keyArea.subarray(0x20, 0x30));
  }

  const sections: NcaSection[] = [];
  for (let i = 0; i < MAX_SECTIONS; i++) {
    const entry = 0x240 + i * 0x10;
    const startUnits = header.readUInt32LE(entry);
    const endUnits = header.readUInt32LE(entry + 4);
    if (startUnits === 0 && endUnits === 0) continue;
    const offset = startUnits * MEDIA_UNIT;
    const end = endUnits * MEDIA_UNIT;
    if (end <= offset) throw new FormatError("INVALID", `NCA section ${i} has inverted bounds`);
    const fsHeader = header.subarray(0x400 + i * FS_HEADER_SIZE, 0x400 + (i + 1) * FS_HEADER_SIZE);
    const encryptionType = fsHeader.readUInt8(0x4);
    if (encryptionType === NcaEncryptionType.AesXts) {
      throw new FormatError("UNSUPPORTED", `NCA section ${i} uses AES-XTS`);
    }
    if (encryptionType === NcaEncryptionType.AesCtrEx && !options.allowAesCtrEx) {
      throw new FormatError("UNSUPPORTED", `NCA section ${i} uses BKTR (AesCtrEx)`);
    }
    sections.push({
      index: i,
      offset,
      end,
      size: end - offset,
      fsType: fsHeader.readUInt8(0x2),
      hashType: fsHeader.readUInt8(0x3),
      encryptionType,
      cryptoKey: encryptionType === NcaEncryptionType.None ? null : Buffer.from(sectionKey),
      cryptoCounter: cryptoCounterFromFsHeader(fsHeader),
      fsOffset: fsOffsetFor(fsHeader),
    });
  }

  return {
    magic,
    contentType: header.readUInt8(0x205),
    keyGeneration,
    kaekIndex,
    size: readU64(header, 0x208),
    titleId: readTitleId(header, 0x210),
    rightsId,
    sections,
  };
}

export async function parseNcaHeader(
  reader: RandomAccessReader,
  keys: Keyset,
  titleKey?: Buffer,
): Promise<NcaInfo> {
  const encrypted = await readExact(reader, 0, NCA_HEADER_SIZE);
  return parseDecryptedNcaHeader(decryptNcaHeader(encrypted, keys), keys, titleKey);
}

export async function decryptNcaSection(
  reader: RandomAccessReader,
  section: NcaSection,
): Promise<Buffer> {
  const encrypted = await readExact(reader, section.offset, section.size);
  if (!section.cryptoKey) return encrypted;
  return aesCtrAt(section.cryptoKey, section.cryptoCounter, section.offset, encrypted);
}

export async function readNcaFs(reader: RandomAccessReader, section: NcaSection): Promise<Buffer> {
  const decrypted = await decryptNcaSection(reader, section);
  if (section.fsOffset > decrypted.length) {
    throw new FormatError(
      "INVALID",
      `NCA section FS offset ${hex(section.fsOffset)} is past the section`,
    );
  }
  return decrypted.subarray(section.fsOffset);
}

export async function readCnmtFromMetaNca(
  reader: RandomAccessReader,
  keys: Keyset,
  titleKey?: Buffer,
): Promise<CnmtInfo> {
  const nca = await parseNcaHeader(reader, keys, titleKey);
  const section = nca.sections[0];
  if (!section) throw new FormatError("INVALID", "meta NCA has no filesystem section");
  const fs = await readNcaFs(reader, section);
  const pfs0 = await parsePfs0(new BufferReader(fs));
  const cnmt = pfs0.entries.find((e) => e.name.toLowerCase().endsWith(".cnmt"));
  if (!cnmt) throw new FormatError("INVALID", "meta NCA PFS0 has no .cnmt file");
  return parseCnmt(fs.subarray(cnmt.offset, cnmt.offset + cnmt.size));
}

const ICON_NAME = /^icon_.*\.dat$/i;

export async function readControlNca(
  reader: RandomAccessReader,
  keys: Keyset,
  titleKey?: Buffer,
): Promise<ControlNcaData> {
  const nca = await parseNcaHeader(reader, keys, titleKey);
  const section = nca.sections[0];
  if (!section) throw new FormatError("INVALID", "control NCA has no filesystem section");
  const fs = await readNcaFs(reader, section);
  const files = parseRomfs(fs);
  const nacpFile = files.find((f) => f.path === "control.nacp");
  if (!nacpFile) throw new FormatError("INVALID", "control RomFS has no control.nacp");
  const iconFile = files.find((f) => ICON_NAME.test(f.path.split("/").pop() ?? ""));
  return {
    nacp: parseNacp(readRomfsFile(fs, nacpFile)),
    icon: iconFile ? readRomfsFile(fs, iconFile) : null,
  };
}
