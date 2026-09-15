/**
 * USB transport framing. See docs/usb-protocol.md.
 *
 * Every message is a 32-byte little-endian header, then `jsonLength` bytes of UTF-8 JSON,
 * then `payloadLength` bytes of binary payload (file data for streamed responses).
 *
 *   0x00 u32  magic "NSLU"
 *   0x04 u16  protocol version
 *   0x06 u8   kind
 *   0x07 u8   flags
 *   0x08 u32  request id
 *   0x0C u16  HTTP-like status (responses), 0 otherwise
 *   0x0E u16  reserved
 *   0x10 u32  json length
 *   0x14 u32  reserved
 *   0x18 u64  payload length
 */

export const USB_VENDOR_ID = 0x057e;
export const USB_PRODUCT_ID = 0x3000;
export const USB_PROTO_VERSION = 1;
export const USB_FRAME_MAGIC = "NSLU";
export const USB_FRAME_HEADER_SIZE = 32;
export const USB_MAX_JSON_LENGTH = 1 << 20;
export const USB_STREAM_CHUNK_SIZE = 1 << 20;

export const FrameKind = {
  Request: 1,
  Response: 2,
  Cancel: 3,
  Ping: 4,
  Pong: 5,
} as const;
export type FrameKind = (typeof FrameKind)[keyof typeof FrameKind];

export const FrameFlags = {
  /** Payload is a raw byte stream (e.g. file contents) rather than empty. */
  RawStream: 1,
} as const;

export interface FrameHeader {
  version: number;
  kind: FrameKind;
  flags: number;
  requestId: number;
  status: number;
  jsonLength: number;
  payloadLength: number;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** JSON section of a Request frame: an HTTP request against the device API. */
export interface UsbRequestJson {
  m: HttpMethod;
  p: string;
  h?: Record<string, string>;
  b?: unknown;
}

/** JSON section of a Response frame. The status lives in the header. */
export interface UsbResponseJson {
  h?: Record<string, string>;
  b?: unknown;
}

export type FrameErrorCode =
  | "SHORT_HEADER"
  | "BAD_MAGIC"
  | "BAD_VERSION"
  | "BAD_KIND"
  | "TOO_LARGE";

export class FrameError extends Error {
  readonly code: FrameErrorCode;

  constructor(code: FrameErrorCode, message: string) {
    super(message);
    this.name = "FrameError";
    this.code = code;
  }
}

const KINDS = new Set<number>(Object.values(FrameKind));
const MAGIC_BYTES = new TextEncoder().encode(USB_FRAME_MAGIC);

export function encodeFrameHeader(
  header: Omit<FrameHeader, "version"> & { version?: number },
): Uint8Array {
  if (header.jsonLength > USB_MAX_JSON_LENGTH) {
    throw new FrameError("TOO_LARGE", `JSON section of ${header.jsonLength} bytes exceeds limit`);
  }
  if (!Number.isSafeInteger(header.payloadLength) || header.payloadLength < 0) {
    throw new FrameError("TOO_LARGE", `Invalid payload length ${header.payloadLength}`);
  }
  const bytes = new Uint8Array(USB_FRAME_HEADER_SIZE);
  const view = new DataView(bytes.buffer);
  bytes.set(MAGIC_BYTES, 0);
  view.setUint16(0x04, header.version ?? USB_PROTO_VERSION, true);
  view.setUint8(0x06, header.kind);
  view.setUint8(0x07, header.flags);
  view.setUint32(0x08, header.requestId, true);
  view.setUint16(0x0c, header.status, true);
  view.setUint32(0x10, header.jsonLength, true);
  view.setBigUint64(0x18, BigInt(header.payloadLength), true);
  return bytes;
}

export function decodeFrameHeader(bytes: Uint8Array): FrameHeader {
  if (bytes.byteLength < USB_FRAME_HEADER_SIZE) {
    throw new FrameError(
      "SHORT_HEADER",
      `Frame header needs ${USB_FRAME_HEADER_SIZE} bytes, got ${bytes.byteLength}`,
    );
  }
  for (let i = 0; i < MAGIC_BYTES.length; i++) {
    if (bytes[i] !== MAGIC_BYTES[i]) throw new FrameError("BAD_MAGIC", "Frame magic mismatch");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, USB_FRAME_HEADER_SIZE);
  const version = view.getUint16(0x04, true);
  if (version !== USB_PROTO_VERSION) {
    throw new FrameError("BAD_VERSION", `Unsupported USB protocol version ${version}`);
  }
  const kind = view.getUint8(0x06);
  if (!KINDS.has(kind)) throw new FrameError("BAD_KIND", `Unknown frame kind ${kind}`);
  const jsonLength = view.getUint32(0x10, true);
  if (jsonLength > USB_MAX_JSON_LENGTH) {
    throw new FrameError("TOO_LARGE", `JSON section of ${jsonLength} bytes exceeds limit`);
  }
  const payloadLength = view.getBigUint64(0x18, true);
  if (payloadLength > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new FrameError("TOO_LARGE", `Payload length ${payloadLength} exceeds safe range`);
  }
  return {
    version,
    kind: kind as FrameKind,
    flags: view.getUint8(0x07),
    requestId: view.getUint32(0x08, true),
    status: view.getUint16(0x0c, true),
    jsonLength,
    payloadLength: Number(payloadLength),
  };
}

export interface EncodeFrameOptions {
  kind: FrameKind;
  requestId: number;
  status?: number;
  flags?: number;
  json?: unknown;
  payload?: Uint8Array;
}

/** Encodes a complete frame held in memory. Streamed payloads write the header and data separately. */
export function encodeFrame(options: EncodeFrameOptions): Uint8Array {
  const json =
    options.json === undefined
      ? new Uint8Array(0)
      : new TextEncoder().encode(JSON.stringify(options.json));
  const payload = options.payload ?? new Uint8Array(0);
  const header = encodeFrameHeader({
    kind: options.kind,
    flags: options.flags ?? 0,
    requestId: options.requestId,
    status: options.status ?? 0,
    jsonLength: json.byteLength,
    payloadLength: payload.byteLength,
  });
  const frame = new Uint8Array(header.byteLength + json.byteLength + payload.byteLength);
  frame.set(header, 0);
  frame.set(json, header.byteLength);
  frame.set(payload, header.byteLength + json.byteLength);
  return frame;
}
