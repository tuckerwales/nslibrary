/**
 * Plaintext ticket (.tik) parsing. A ticket's rights ID encodes the title ID (first 8 bytes)
 * and key generation (last byte), so it identifies titlekey-encrypted content without keys.
 */
import { FormatError, hex } from "./binary";

/** Signature type → [signature size, padding size]. */
const SIGNATURE_LAYOUT = new Map<number, [number, number]>([
  [0x10000, [0x200, 0x3c]], // RSA-4096 SHA-1
  [0x10001, [0x100, 0x3c]], // RSA-2048 SHA-1
  [0x10002, [0x3c, 0x40]], // ECDSA SHA-1
  [0x10003, [0x200, 0x3c]], // RSA-4096 SHA-256
  [0x10004, [0x100, 0x3c]], // RSA-2048 SHA-256
  [0x10005, [0x3c, 0x40]], // ECDSA SHA-256
  [0x10006, [0x14, 0x28]], // HMAC SHA-1
]);

const TICKET_DATA_SIZE = 0x180;

export type TitleKeyType = "common" | "personalized";

export interface TicketInfo {
  signatureType: number;
  issuer: string;
  titleKeyType: TitleKeyType;
  keyGeneration: number;
  /** 32 uppercase hex digits. */
  rightsId: string;
  /** 16 uppercase hex digits (first half of the rights ID). */
  titleId: string;
  /**
   * Encrypted title key block. Needed to decrypt the user's own content locally; must never be
   * returned by an API or logged.
   */
  titleKeyBlock: Buffer;
}

export function parseTicket(data: Buffer): TicketInfo {
  if (data.length < 4)
    throw new FormatError("TRUNCATED", "ticket is shorter than its signature type");
  const signatureType = data.readUInt32LE(0);
  const layout = SIGNATURE_LAYOUT.get(signatureType);
  if (!layout) {
    throw new FormatError("UNSUPPORTED", `unknown ticket signature type ${hex(signatureType)}`);
  }
  const dataStart = 4 + layout[0] + layout[1];
  if (data.length < dataStart + TICKET_DATA_SIZE) {
    throw new FormatError(
      "TRUNCATED",
      `ticket needs ${hex(dataStart + TICKET_DATA_SIZE)} bytes, has ${hex(data.length)}`,
    );
  }

  const issuerEnd = data.indexOf(0, dataStart);
  const issuer = data.toString(
    "latin1",
    dataStart,
    issuerEnd === -1 || issuerEnd > dataStart + 0x40 ? dataStart + 0x40 : issuerEnd,
  );
  const rightsIdBytes = data.subarray(dataStart + 0x160, dataStart + 0x170);
  const rightsId = rightsIdBytes.toString("hex").toUpperCase();

  return {
    signatureType,
    issuer,
    titleKeyType: data.readUInt8(dataStart + 0x141) === 1 ? "personalized" : "common",
    keyGeneration: data.readUInt8(dataStart + 0x145),
    rightsId,
    titleId: rightsId.slice(0, 16),
    titleKeyBlock: Buffer.from(data.subarray(dataStart + 0x40, dataStart + 0x140)),
  };
}
