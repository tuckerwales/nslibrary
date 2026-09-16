/**
 * Packaged Content Meta (CNMT): title ID, version, type, required firmware, and the SHA-256
 * of each NCA in the package.
 */
import { FormatError, hex, readTitleId } from "./binary";

export const CNMT_HEADER_SIZE = 0x20;
export const CNMT_CONTENT_RECORD_SIZE = 0x38;
export const CNMT_DIGEST_SIZE = 0x20;

export const CnmtType = {
  Application: 0x80,
  Patch: 0x81,
  AddOnContent: 0x82,
  Delta: 0x83,
} as const;

export const CnmtContentType = {
  Meta: 0,
  Program: 1,
  Data: 2,
  Control: 3,
  HtmlDocument: 4,
  LegalInformation: 5,
  DeltaFragment: 6,
} as const;

export type PackagedContentKind = "application" | "patch" | "addon" | "other";

export interface CnmtContentRecord {
  /** SHA-256 of the NCA (decompressed, if it was stored as NCZ). */
  sha256: string;
  /** First 16 bytes of that hash, 32 lowercase hex digits — the NCA filename stem. */
  ncaId: string;
  size: number;
  type: number;
  idOffset: number;
}

export interface CnmtInfo {
  titleId: string;
  version: number;
  rawType: number;
  kind: PackagedContentKind;
  /** Title ID of the base game; equal to `titleId` for applications. */
  applicationId: string;
  requiredSystemVersion: number | null;
  requiredApplicationVersion: number | null;
  contents: CnmtContentRecord[];
  /** Sum of packaged content sizes (the install footprint). */
  installSize: number;
}

function kindOf(rawType: number): PackagedContentKind {
  switch (rawType) {
    case CnmtType.Application:
      return "application";
    case CnmtType.Patch:
      return "patch";
    case CnmtType.AddOnContent:
      return "addon";
    default:
      return "other";
  }
}

function contentRecord(buf: Buffer, offset: number): CnmtContentRecord {
  const sha256 = buf.subarray(offset, offset + 0x20).toString("hex");
  return {
    sha256,
    ncaId: buf.subarray(offset + 0x20, offset + 0x30).toString("hex"),
    size: buf.readUIntLE(offset + 0x30, 5),
    type: buf.readUInt8(offset + 0x36),
    idOffset: buf.readUInt8(offset + 0x37),
  };
}

export function parseCnmt(data: Buffer): CnmtInfo {
  if (data.length < CNMT_HEADER_SIZE) {
    throw new FormatError("TRUNCATED", `CNMT is ${hex(data.length)} bytes, expected a 0x20 header`);
  }
  const titleId = readTitleId(data, 0);
  const version = data.readUInt32LE(0x8);
  const rawType = data.readUInt8(0xc);
  const extendedHeaderSize = data.readUInt16LE(0xe);
  const contentCount = data.readUInt16LE(0x10);
  const tableOffset = CNMT_HEADER_SIZE + extendedHeaderSize;
  const recordsEnd = tableOffset + contentCount * CNMT_CONTENT_RECORD_SIZE;
  if (data.length < recordsEnd) {
    throw new FormatError(
      "TRUNCATED",
      `CNMT needs ${hex(recordsEnd)} bytes for ${contentCount} records, has ${hex(data.length)}`,
    );
  }

  const extended = data.subarray(CNMT_HEADER_SIZE, tableOffset);
  let applicationId = titleId;
  let requiredSystemVersion: number | null = null;
  let requiredApplicationVersion: number | null = null;
  const kind = kindOf(rawType);
  if (kind === "application" && extended.length >= 0x0c) {
    requiredSystemVersion = extended.readUInt32LE(0x8);
  } else if (kind === "patch" && extended.length >= 0x0c) {
    applicationId = readTitleId(extended, 0);
    requiredSystemVersion = extended.readUInt32LE(0x8);
  } else if (kind === "addon" && extended.length >= 0x08) {
    applicationId = readTitleId(extended, 0);
    if (extended.length >= 0x0c) requiredApplicationVersion = extended.readUInt32LE(0x8);
  }

  const contents: CnmtContentRecord[] = [];
  for (let i = 0; i < contentCount; i++) {
    contents.push(contentRecord(data, tableOffset + i * CNMT_CONTENT_RECORD_SIZE));
  }

  return {
    titleId,
    version,
    rawType,
    kind,
    applicationId,
    requiredSystemVersion,
    requiredApplicationVersion,
    contents,
    installSize: contents.reduce((sum, c) => sum + c.size, 0),
  };
}
