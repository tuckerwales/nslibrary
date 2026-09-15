import { deterministicBytes } from "./bytes";

const SIGNATURE_LAYOUT: Record<number, [number, number]> = {
  65536: [0x200, 0x3c],
  65539: [0x200, 0x3c],
  65540: [0x100, 0x3c],
  65541: [0x3c, 0x40],
};

export interface TicketBuildOptions {
  /** 32 hex digits: title ID followed by 15 zero nibbles and the key generation byte. */
  rightsId: string;
  personalized?: boolean;
  keyGeneration?: number;
  signatureType?: keyof typeof SIGNATURE_LAYOUT;
}

export function rightsIdFor(titleId: string, keyGeneration: number): string {
  return `${titleId}${"0".repeat(14)}${keyGeneration.toString(16).padStart(2, "0")}`.toUpperCase();
}

/** A ticket with a made-up signature and title key. */
export function buildTicket(options: TicketBuildOptions): Buffer {
  const signatureType = options.signatureType ?? 0x10004;
  const [signatureSize, padding] = SIGNATURE_LAYOUT[signatureType] ?? [0x100, 0x3c];
  const dataStart = 4 + signatureSize + padding;
  const ticket = Buffer.alloc(dataStart + 0x180);

  ticket.writeUInt32LE(signatureType, 0);
  deterministicBytes(`ticket:${options.rightsId}:signature`, signatureSize).copy(ticket, 4);
  ticket.write("Root-CA00000003-XS00000020", dataStart, "latin1");
  deterministicBytes(`ticket:${options.rightsId}:title-key`, 16).copy(ticket, dataStart + 0x40);
  ticket.writeUInt8(2, dataStart + 0x140); // format version
  ticket.writeUInt8(options.personalized ? 1 : 0, dataStart + 0x141);
  ticket.writeUInt8(options.keyGeneration ?? 0, dataStart + 0x145);
  Buffer.from(options.rightsId, "hex").copy(ticket, dataStart + 0x160);
  return ticket;
}
