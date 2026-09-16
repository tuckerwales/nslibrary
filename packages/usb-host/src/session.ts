import {
  decodeFrameHeader,
  encodeFrame,
  encodeFrameHeader,
  FrameFlags,
  FrameKind,
  USB_FRAME_HEADER_SIZE,
  USB_STREAM_CHUNK_SIZE,
  type UsbRequestJson,
  type UsbResponseJson,
} from "@nslib/shared";
import type { ByteChannel } from "./duplex";

export interface UsbHandlerResult {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  payload?: Uint8Array;
}

export interface UsbRequestHandler {
  handle(req: UsbRequestJson, payload: Uint8Array, requestId: number): Promise<UsbHandlerResult>;
  onDetach?(): void;
}

export interface UsbLinkOptions {
  handler: UsbRequestHandler;
  /** Idle timeout before the host treats the Switch as gone. 0 disables. */
  idleMs?: number;
  log?: (message: string, err?: unknown) => void;
}

function headerToObject(bytes: Uint8Array): Record<string, never> | UsbRequestJson {
  if (bytes.byteLength === 0) return {};
  return JSON.parse(new TextDecoder().decode(bytes)) as UsbRequestJson;
}

export class UsbLink {
  readonly #channel: ByteChannel;
  readonly #handler: UsbRequestHandler;
  readonly #idleMs: number;
  readonly #log?: (message: string, err?: unknown) => void;
  #lastRx = Date.now();
  #running = false;
  #bytesIn = 0;
  #bytesOut = 0;
  #startedAt = 0;

  constructor(channel: ByteChannel, options: UsbLinkOptions) {
    this.#channel = channel;
    this.#handler = options.handler;
    this.#idleMs = options.idleMs ?? 15_000;
    this.#log = options.log;
  }

  /** Inbound + outbound bytes since `run` started, for MB/s logs. */
  stats(): { bytesIn: number; bytesOut: number; elapsedMs: number } {
    return {
      bytesIn: this.#bytesIn,
      bytesOut: this.#bytesOut,
      elapsedMs: Date.now() - this.#startedAt,
    };
  }

  async run(signal?: AbortSignal): Promise<void> {
    this.#running = true;
    this.#startedAt = Date.now();
    this.#lastRx = Date.now();
    try {
      while (this.#running && !signal?.aborted && !this.#channel.closed) {
        const headerBytes = await this.#readExact(USB_FRAME_HEADER_SIZE, signal);
        this.#lastRx = Date.now();
        const header = decodeFrameHeader(headerBytes);
        const jsonBytes = header.jsonLength
          ? await this.#readExact(header.jsonLength, signal)
          : new Uint8Array(0);
        const payload = header.payloadLength
          ? await this.#readExact(header.payloadLength, signal)
          : new Uint8Array(0);
        this.#bytesIn += headerBytes.byteLength + jsonBytes.byteLength + payload.byteLength;

        if (header.kind === FrameKind.Ping) {
          await this.#writeFrame({
            kind: FrameKind.Pong,
            requestId: header.requestId,
          });
          continue;
        }
        if (header.kind === FrameKind.Cancel) {
          continue;
        }
        if (header.kind !== FrameKind.Request) {
          this.#log?.(`Ignoring USB frame kind ${header.kind}`);
          continue;
        }
        const req = headerToObject(jsonBytes) as UsbRequestJson;
        try {
          const result = await this.#handler.handle(req, payload, header.requestId);
          const json: UsbResponseJson = {};
          if (result.headers && Object.keys(result.headers).length > 0) json.h = result.headers;
          if (result.body !== undefined) json.b = result.body;
          const payloadOut = result.payload ?? new Uint8Array(0);
          await this.#writeFrame({
            kind: FrameKind.Response,
            requestId: header.requestId,
            status: result.status,
            flags: payloadOut.byteLength > 0 ? FrameFlags.RawStream : 0,
            json: Object.keys(json).length > 0 ? json : undefined,
            payload: payloadOut,
          });
        } catch (err) {
          const code =
            err && typeof err === "object" && "code" in err
              ? String((err as { code: string }).code)
              : "INTERNAL";
          const status =
            err && typeof err === "object" && "status" in err
              ? Number((err as { status: number }).status)
              : 500;
          const msg = err instanceof Error ? err.message : String(err);
          await this.#writeFrame({
            kind: FrameKind.Response,
            requestId: header.requestId,
            status: Number.isFinite(status) ? status : 500,
            json: { b: { error: { code, msg } } },
          });
        }
      }
    } finally {
      this.#running = false;
      this.#handler.onDetach?.();
    }
  }

  stop(): void {
    this.#running = false;
    this.#channel.close();
  }

  async #readExact(n: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (this.#idleMs <= 0) return this.#channel.readExact(n, signal);
    const timeout = AbortSignal.timeout(this.#idleMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await this.#channel.readExact(n, combined);
    } catch (err) {
      if (timeout.aborted && Date.now() - this.#lastRx >= this.#idleMs) {
        throw new Error("USB idle timeout");
      }
      throw err;
    }
  }

  async #writeFrame(options: Parameters<typeof encodeFrame>[0]): Promise<void> {
    const payload = options.payload;
    if (!payload || payload.byteLength <= USB_STREAM_CHUNK_SIZE) {
      const frame = encodeFrame(options);
      this.#bytesOut += frame.byteLength;
      await this.#channel.write(frame);
      return;
    }
    const json =
      options.json === undefined
        ? new Uint8Array(0)
        : new TextEncoder().encode(JSON.stringify(options.json));
    const header = encodeFrameHeader({
      kind: options.kind,
      flags: options.flags ?? 0,
      requestId: options.requestId,
      status: options.status ?? 0,
      jsonLength: json.byteLength,
      payloadLength: payload.byteLength,
    });
    await this.#channel.write(header);
    if (json.byteLength) await this.#channel.write(json);
    this.#bytesOut += header.byteLength + json.byteLength;
    for (let offset = 0; offset < payload.byteLength; offset += USB_STREAM_CHUNK_SIZE) {
      const chunk = payload.subarray(offset, offset + USB_STREAM_CHUNK_SIZE);
      await this.#channel.write(chunk);
      this.#bytesOut += chunk.byteLength;
    }
  }
}
