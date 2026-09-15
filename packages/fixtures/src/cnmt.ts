import { createHash } from "node:crypto";

export const CnmtType = {
  Application: 0x80,
  Patch: 0x81,
  AddOnContent: 0x82,
} as const;

export const CnmtContentType = {
  Meta: 0,
  Program: 1,
  Data: 2,
  Control: 3,
  HtmlDocument: 4,
  LegalInformation: 5,
} as const;

export interface CnmtContentSpec {
  nca: Buffer;
  type: number;
}

export interface CnmtBuildOptions {
  titleId: string;
  version: number;
  type: number;
  /** Base-game title ID; required for patch and DLC. */
  applicationId?: string;
  requiredSystemVersion?: number;
  requiredApplicationVersion?: number;
  contents: CnmtContentSpec[];
}

function writeTitleId(buf: Buffer, offset: number, titleId: string): void {
  buf.writeBigUInt64LE(BigInt(`0x${titleId}`), offset);
}

export function ncaSha256(nca: Buffer): Buffer {
  return createHash("sha256").update(nca).digest();
}

export function ncaId(nca: Buffer): string {
  return ncaSha256(nca).subarray(0, 16).toString("hex");
}

export function buildCnmt(options: CnmtBuildOptions): Buffer {
  const extendedSize = options.type === CnmtType.Application ? 0x10 : 0x18;
  const tableOffset = 0x20 + extendedSize;
  const body = Buffer.alloc(tableOffset + options.contents.length * 0x38 + 0x20);

  writeTitleId(body, 0, options.titleId);
  body.writeUInt32LE(options.version, 0x8);
  body.writeUInt8(options.type, 0xc);
  body.writeUInt16LE(extendedSize, 0xe);
  body.writeUInt16LE(options.contents.length, 0x10);

  if (options.type === CnmtType.Application) {
    writeTitleId(body, 0x20, options.titleId.replace(/000$/, "800"));
    body.writeUInt32LE(options.requiredSystemVersion ?? 0, 0x28);
  } else if (options.type === CnmtType.Patch) {
    writeTitleId(body, 0x20, options.applicationId ?? options.titleId.replace(/800$/, "000"));
    body.writeUInt32LE(options.requiredSystemVersion ?? 0, 0x28);
  } else if (options.type === CnmtType.AddOnContent) {
    writeTitleId(body, 0x20, options.applicationId ?? `${options.titleId.slice(0, 13)}000`);
    body.writeUInt32LE(options.requiredApplicationVersion ?? 0, 0x28);
  }

  options.contents.forEach((content, i) => {
    const o = tableOffset + i * 0x38;
    const hash = ncaSha256(content.nca);
    hash.copy(body, o);
    hash.subarray(0, 16).copy(body, o + 0x20);
    body.writeUIntLE(content.nca.length, o + 0x30, 5);
    body.writeUInt8(content.type, o + 0x36);
  });

  return body;
}
