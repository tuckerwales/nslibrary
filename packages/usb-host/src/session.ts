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

/**
 * A payload produced piece by piece, so large file ranges never sit in memory. `chunks` must yield
 * exactly `length` bytes: the frame header announces the length before any data is sent, so a
 * stream that ends early or runs over can't be answered cleanly and closes the link instead.
 */
export interface UsbStreamPayload {
  length: number;
  chunks: AsyncIterable<Uint8Array>;
}

export interface UsbHandlerResult {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  payload?: Uint8Array | UsbStreamPayload;
}

function payloadLength(payload: UsbHandlerResult["payload"]): number {
  if (!payload) return 0;
  return payload instanceof Uint8Array ? payload.byteLength : payload.length;
}

export interface UsbRequestHandler {
  /**
   * A payload up to one USB chunk arrives whole. A bigger one (a save upload) is a stream read
   * straight off the link, so it never has to fit in memory; whatever the handler leaves unread is
   * drained before the response goes out.
   */
  handle(
    req: UsbRequestJson,
    payload: Uint8Array | UsbStreamPayload,
    requestId: number,
  ): Promise<UsbHandlerResult>;
  onDetach?(): void;
}

export interface UsbLinkOptions {
  handler: UsbRequestHandler;
  /** Idle timeout before the host treats the Switch as gone. 0 disables. */
  idleMs?: number;
  /**
   * Largest request payload accepted (save uploads). A bigger one is read and discarded so the
   * next frame still lines up, and answered with PAYLOAD_TOO_LARGE. Defaults to 1 GiB.
   */
  maxRequestPayload?: number;
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
  readonly #maxRequestPayload: number;
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
    this.#maxRequestPayload = options.maxRequestPayload ?? 1024 * 1024 * 1024;
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
        this.#bytesIn += headerBytes.byteLength + jsonBytes.byteLength + header.payloadLength;
        const accepted =
          header.kind === FrameKind.Request && header.payloadLength <= this.#maxRequestPayload;
        if (!accepted && header.payloadLength) await this.#discard(header.payloadLength, signal);

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
        if (!accepted) {
          await this.#writeFrame({
            kind: FrameKind.Response,
            requestId: header.requestId,
            status: 413,
            json: {
              b: {
                error: {
                  code: "PAYLOAD_TOO_LARGE",
                  msg: `USB requests larger than ${this.#maxRequestPayload} bytes are not accepted`,
                },
              },
            },
          });
          continue;
        }
        const req = headerToObject(jsonBytes) as UsbRequestJson;
        const body = await this.#requestBody(header.payloadLength, signal);
        let result: UsbHandlerResult | undefined;
        let failure: unknown;
        try {
          result = await this.#handler.handle(req, body.payload, header.requestId);
        } catch (err) {
          failure = err;
        }
        // The Switch sends the whole body before it reads a reply, so answering first would stall
        // both ends. A failed read here means the link itself is gone.
        await body.drain();
        if (!result) {
          const err = failure;
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
          continue;
        }
        const json: UsbResponseJson = {};
        if (result.headers && Object.keys(result.headers).length > 0) json.h = result.headers;
        if (result.body !== undefined) json.b = result.body;
        try {
          await this.#writeResponse(header.requestId, result, json);
        } catch (err) {
          // Part of the response may already be on the wire, so the next frame can't line up.
          this.#log?.("USB response failed mid-stream; closing the link", err);
          this.#channel.close();
          throw err;
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

  /** Reads and drops a payload a chunk at a time, so the next frame still lines up. */
  async #discard(length: number, signal?: AbortSignal): Promise<void> {
    for (let done = 0; done < length; ) {
      const chunk = await this.#readExact(Math.min(USB_STREAM_CHUNK_SIZE, length - done), signal);
      this.#lastRx = Date.now();
      done += chunk.byteLength;
    }
  }

  /**
   * A request payload for the handler: read whole when it fits one chunk, else streamed off the
   * link a chunk at a time, so the idle timeout applies per chunk and a large upload is not
   * mistaken for a silent Switch. `drain` reads whatever the handler left unread.
   */
  async #requestBody(
    length: number,
    signal?: AbortSignal,
  ): Promise<{ payload: Uint8Array | UsbStreamPayload; drain: () => Promise<void> }> {
    if (length <= USB_STREAM_CHUNK_SIZE) {
      const payload = length ? await this.#readExact(length, signal) : new Uint8Array(0);
      if (length) this.#lastRx = Date.now();
      return { payload, drain: async () => {} };
    }
    let read = 0;
    const next = async (): Promise<Uint8Array> => {
      const chunk = await this.#readExact(Math.min(USB_STREAM_CHUNK_SIZE, length - read), signal);
      this.#lastRx = Date.now();
      read += chunk.byteLength;
      return chunk;
    };
    const chunks = (async function* () {
      while (read < length) yield await next();
    })();
    return {
      payload: { length, chunks },
      drain: async () => {
        // Waits for a read still in flight, and stops the handler reading any further.
        await chunks.return(undefined);
        if (read < length) await this.#discard(length - read, signal);
      },
    };
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

  async #writeResponse(
    requestId: number,
    result: UsbHandlerResult,
    json: UsbResponseJson,
  ): Promise<void> {
    const length = payloadLength(result.payload);
    const options = {
      kind: FrameKind.Response,
      requestId,
      status: result.status,
      flags: length > 0 ? FrameFlags.RawStream : 0,
      json: Object.keys(json).length > 0 ? json : undefined,
    };
    if (!result.payload || result.payload instanceof Uint8Array) {
      await this.#writeFrame({ ...options, payload: result.payload });
      return;
    }
    const encodedJson =
      options.json === undefined
        ? new Uint8Array(0)
        : new TextEncoder().encode(JSON.stringify(options.json));
    const frameHeader = encodeFrameHeader({
      kind: options.kind,
      flags: options.flags,
      requestId,
      status: options.status,
      jsonLength: encodedJson.byteLength,
      payloadLength: length,
    });
    await this.#channel.write(frameHeader);
    if (encodedJson.byteLength) await this.#channel.write(encodedJson);
    this.#bytesOut += frameHeader.byteLength + encodedJson.byteLength;
    let sent = 0;
    for await (const chunk of result.payload.chunks) {
      if (sent + chunk.byteLength > length) {
        throw new Error(`USB stream produced more than the ${length} bytes it announced`);
      }
      for (let offset = 0; offset < chunk.byteLength; offset += USB_STREAM_CHUNK_SIZE) {
        const piece = chunk.subarray(offset, offset + USB_STREAM_CHUNK_SIZE);
        await this.#channel.write(piece);
        this.#bytesOut += piece.byteLength;
      }
      sent += chunk.byteLength;
    }
    if (sent !== length) {
      throw new Error(`USB stream ended after ${sent} of ${length} bytes`);
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
