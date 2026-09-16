/**
 * Synthetic NCA3 files encrypted with the fake keyset. Structurally valid enough to exercise
 * header XTS, key-area unwrap, section CTR, CNMT, and control RomFS — no copyrighted data.
 */
import { createHash } from "node:crypto";
import { deterministicBytes } from "./bytes";
import { buildCnmt, CnmtContentType, CnmtType, ncaId } from "./cnmt";
import { aesCtrAt, aesEcb, nintendoXtsCrypt } from "./crypto";
import { kaekName, masterKeyIndex } from "./keyset";
import { buildNacp, fakeJpeg } from "./nro";
import { buildPfs0 } from "./partition";
import { buildRomfs } from "./romfs";
import { buildTicket, rightsIdFor } from "./ticket";

export const NCA_HEADER_SIZE = 0xc00;
const MEDIA_UNIT = 0x200;

export const NcaContentType = {
  Program: 0,
  Meta: 1,
  Control: 2,
} as const;

function writeTitleId(buf: Buffer, offset: number, titleId: string): void {
  buf.writeBigUInt64LE(BigInt(`0x${titleId}`), offset);
}

function padTo(data: Buffer, alignment: number): Buffer {
  const size = Math.ceil(data.length / alignment) * alignment;
  return size === data.length ? data : Buffer.concat([data, Buffer.alloc(size - data.length)]);
}

function wrapPfs0(pfs0: Buffer, blockSize = 0x200): { section: Buffer; hashData: Buffer } {
  const hashCount = Math.max(1, Math.ceil(pfs0.length / blockSize));
  const hashTable = Buffer.alloc(hashCount * 0x20);
  for (let i = 0; i < hashCount; i++) {
    const block = pfs0.subarray(i * blockSize, Math.min((i + 1) * blockSize, pfs0.length));
    createHash("sha256")
      .update(block)
      .digest()
      .copy(hashTable, i * 0x20);
  }
  const hashData = Buffer.alloc(0xf8);
  createHash("sha256").update(hashTable).digest().copy(hashData, 0);
  hashData.writeUInt32LE(blockSize, 0x20);
  hashData.writeUInt32LE(2, 0x24);
  hashData.writeBigUInt64LE(0n, 0x28);
  hashData.writeBigUInt64LE(BigInt(hashTable.length), 0x30);
  hashData.writeBigUInt64LE(BigInt(hashTable.length), 0x38);
  hashData.writeBigUInt64LE(BigInt(pfs0.length), 0x40);
  return { section: Buffer.concat([hashTable, pfs0]), hashData };
}

function wrapRomfs(romfs: Buffer): { section: Buffer; hashData: Buffer } {
  const hashData = Buffer.alloc(0xf8);
  hashData.write("IVFC", 0, "latin1");
  hashData.writeUInt32LE(2, 0x4);
  hashData.writeUInt32LE(0x20, 0x8);
  hashData.writeUInt32LE(2, 0x0c);
  hashData.writeUInt32LE(14, 0x10 + 16);
  hashData.writeBigUInt64LE(BigInt(romfs.length), 0x10 + 0x18 + 8);
  hashData.writeUInt32LE(14, 0x10 + 0x18 + 16);
  return { section: romfs, hashData };
}

export interface BuildNcaOptions {
  seed?: string;
  contentType: number;
  titleId: string;
  keys: ReadonlyMap<string, Buffer>;
  keyGeneration?: number;
  kaekIndex?: number;
  rightsId?: string;
  /** Plaintext title key; required when `rightsId` is set. */
  titleKey?: Buffer;
  fs: { type: "pfs0" | "romfs"; data: Buffer };
}

export function buildNca(options: BuildNcaOptions): Buffer {
  const keyGeneration = options.keyGeneration ?? 0;
  const kaekIndex = options.kaekIndex ?? 0;
  const headerKey = options.keys.get("header_key");
  if (headerKey === undefined || headerKey.length !== 32) {
    throw new Error("buildNca needs header_key");
  }

  const wrapped =
    options.fs.type === "pfs0" ? wrapPfs0(options.fs.data) : wrapRomfs(options.fs.data);
  const section = padTo(wrapped.section, MEDIA_UNIT);
  const sectionStart = NCA_HEADER_SIZE;
  const ncaSize = sectionStart + section.length;

  const fsHeader = Buffer.alloc(0x200);
  fsHeader.writeUInt16LE(2, 0);
  fsHeader.writeUInt8(options.fs.type === "pfs0" ? 1 : 0, 0x2);
  fsHeader.writeUInt8(options.fs.type === "pfs0" ? 2 : 3, 0x3);
  fsHeader.writeUInt8(3, 0x4);
  wrapped.hashData.copy(fsHeader, 0x8);

  const plainKeyArea = deterministicBytes(`${options.seed ?? options.titleId}:key-area`, 0x40);
  const kaek = options.keys.get(kaekName(kaekIndex, masterKeyIndex(keyGeneration)));
  if (!kaek)
    throw new Error(`buildNca needs ${kaekName(kaekIndex, masterKeyIndex(keyGeneration))}`);
  const encKeyArea = aesEcb(kaek, plainKeyArea, true);
  const ctrKey = options.rightsId
    ? (options.titleKey ?? Buffer.alloc(16))
    : plainKeyArea.subarray(0x20, 0x30);
  const cryptoCounter = Buffer.alloc(16);
  const encryptedSection = aesCtrAt(ctrKey, cryptoCounter, sectionStart, section);

  const header = Buffer.alloc(NCA_HEADER_SIZE);
  header.write("NCA3", 0x200, "latin1");
  header.writeUInt8(options.contentType, 0x205);
  header.writeUInt8(keyGeneration <= 2 ? keyGeneration : 2, 0x206);
  header.writeUInt8(kaekIndex, 0x207);
  header.writeBigUInt64LE(BigInt(ncaSize), 0x208);
  writeTitleId(header, 0x210, options.titleId);
  header.writeUInt8(keyGeneration, 0x220);
  if (options.rightsId) Buffer.from(options.rightsId, "hex").copy(header, 0x230);
  header.writeUInt32LE(sectionStart / MEDIA_UNIT, 0x240);
  header.writeUInt32LE(ncaSize / MEDIA_UNIT, 0x244);
  createHash("sha256").update(fsHeader).digest().copy(header, 0x280);
  encKeyArea.copy(header, 0x300);
  fsHeader.copy(header, 0x400);

  return Buffer.concat([nintendoXtsCrypt(headerKey, header, true), encryptedSection]);
}

export interface ControlNcaOptions {
  titleId: string;
  keys: ReadonlyMap<string, Buffer>;
  name: string;
  publisher: string;
  displayVersion?: string;
  icon?: Buffer | null;
  addOnContentBaseId?: bigint;
  keyGeneration?: number;
}

export function buildControlNca(options: ControlNcaOptions): Buffer {
  const files = [
    {
      name: "control.nacp",
      data: buildNacp({
        name: options.name,
        publisher: options.publisher,
        displayVersion: options.displayVersion ?? "1.0.0",
        addOnContentBaseId: options.addOnContentBaseId,
      }),
    },
  ];
  if (options.icon !== null) {
    files.push({
      name: "icon_AmericanEnglish.dat",
      data: options.icon ?? fakeJpeg(options.name, 0x400),
    });
  }
  return buildNca({
    contentType: NcaContentType.Control,
    titleId: options.titleId,
    keys: options.keys,
    keyGeneration: options.keyGeneration,
    fs: { type: "romfs", data: buildRomfs(files) },
  });
}

export interface MetaNcaOptions {
  titleId: string;
  version: number;
  type: number;
  keys: ReadonlyMap<string, Buffer>;
  contents: { nca: Buffer; type: number }[];
  applicationId?: string;
  requiredSystemVersion?: number;
  keyGeneration?: number;
}

export function buildMetaNca(options: MetaNcaOptions): Buffer {
  const cnmt = buildCnmt({
    titleId: options.titleId,
    version: options.version,
    type: options.type,
    applicationId: options.applicationId,
    requiredSystemVersion: options.requiredSystemVersion,
    contents: options.contents,
  });
  const kind =
    options.type === CnmtType.Patch
      ? "Patch"
      : options.type === CnmtType.AddOnContent
        ? "AddOnContent"
        : "Application";
  const pfs0 = buildPfs0([{ name: `${kind}_${options.titleId.toLowerCase()}.cnmt`, data: cnmt }]);
  return buildNca({
    contentType: NcaContentType.Meta,
    titleId: options.titleId,
    keys: options.keys,
    keyGeneration: options.keyGeneration,
    fs: { type: "pfs0", data: pfs0 },
  });
}

export interface TitlePackageOptions {
  titleId: string;
  version?: number;
  type?: number;
  keys: ReadonlyMap<string, Buffer>;
  name: string;
  publisher?: string;
  icon?: Buffer | null;
  requiredSystemVersion?: number;
  keyGeneration?: number;
  /** Base-game title ID; inferred from a patch title ID, required for DLC. */
  applicationId?: string;
  /** Include a ticket so keyless inspection still identifies the title. */
  ticket?: boolean;
}

export interface TitlePackage {
  nsp: Buffer;
  meta: Buffer;
  control: Buffer;
  program: Buffer;
}

export function buildTitleNsp(options: TitlePackageOptions): TitlePackage {
  const version = options.version ?? 0;
  const type = options.type ?? CnmtType.Application;
  const keyGeneration = options.keyGeneration ?? 0;
  const program = buildNca({
    seed: `${options.titleId}:program`,
    contentType: NcaContentType.Program,
    titleId: options.titleId,
    keys: options.keys,
    keyGeneration,
    fs: {
      type: "pfs0",
      data: buildPfs0([
        { name: "main", data: deterministicBytes(`${options.titleId}:main`, 0x100) },
      ]),
    },
  });
  const applicationId =
    options.applicationId ??
    (type === CnmtType.Patch ? options.titleId.replace(/800$/, "000") : options.titleId);
  const control = buildControlNca({
    titleId: options.titleId,
    keys: options.keys,
    name: options.name,
    publisher: options.publisher ?? "Fixture",
    icon: options.icon,
    keyGeneration,
    addOnContentBaseId:
      type === CnmtType.AddOnContent ? BigInt(`0x${applicationId}`) | 0x1000n : undefined,
  });
  const meta = buildMetaNca({
    titleId: options.titleId,
    version,
    type,
    keys: options.keys,
    keyGeneration,
    requiredSystemVersion: options.requiredSystemVersion,
    applicationId: type === CnmtType.Application ? undefined : applicationId,
    contents: [
      { nca: program, type: CnmtContentType.Program },
      { nca: control, type: CnmtContentType.Control },
    ],
  });

  const files = [
    { name: `${ncaId(meta)}.cnmt.nca`, data: meta },
    { name: `${ncaId(control)}.nca`, data: control },
    { name: `${ncaId(program)}.nca`, data: program },
  ];
  if (options.ticket !== false) {
    const rightsId = rightsIdFor(options.titleId, keyGeneration);
    files.push(
      { name: `${rightsId.toLowerCase()}.tik`, data: buildTicket({ rightsId, keyGeneration }) },
      {
        name: `${rightsId.toLowerCase()}.cert`,
        data: deterministicBytes(`${options.titleId}:cert`, 0x700),
      },
    );
  }

  return { nsp: buildPfs0(files), meta, control, program };
}
