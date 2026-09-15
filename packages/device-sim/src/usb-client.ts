import {
  decodeFrameHeader,
  encodeFrame,
  FrameKind,
  type HelloResponse,
  type PairRequest,
  type PairResponse,
  USB_FRAME_HEADER_SIZE,
  type UsbRequestJson,
  type UsbResponseJson,
} from "@nslib/shared";
import type { ByteChannel } from "@nslib/usb-host/duplex";
import { DeviceApiError } from "./client";

export interface UsbExchange {
  status: number;
  json: UsbResponseJson;
  payload: Uint8Array;
}

export class UsbDeviceClient {
  #nextId = 1;

  constructor(
    public channel: ByteChannel,
    public token?: string,
  ) {}

  async usbHello(device: {
    deviceUuid: string;
    name: string;
    fw: string;
    amsVersion: string;
    appVersion: string;
  }): Promise<PairResponse> {
    const res = await this.exchange("POST", "/usb/hello", { body: device, auth: false });
    const paired = res.json.b as PairResponse;
    this.token = paired.token;
    return paired;
  }

  async pair(body: PairRequest): Promise<PairResponse> {
    const res = await this.exchange("POST", "/pair", { body, auth: false });
    const paired = res.json.b as PairResponse;
    this.token = paired.token;
    return paired;
  }

  hello(): Promise<HelloResponse> {
    return this.exchange("GET", "/hello").then((r) => r.json.b as HelloResponse);
  }

  async ping(): Promise<void> {
    const requestId = this.#nextId++;
    await this.channel.write(encodeFrame({ kind: FrameKind.Ping, requestId }));
    const headerBytes = await this.channel.readExact(USB_FRAME_HEADER_SIZE);
    const header = decodeFrameHeader(headerBytes);
    if (header.kind !== FrameKind.Pong || header.requestId !== requestId) {
      throw new Error(`expected Pong for ${requestId}, got kind ${header.kind}`);
    }
  }

  async exchange(
    method: UsbRequestJson["m"],
    path: string,
    options: {
      body?: unknown;
      headers?: Record<string, string>;
      auth?: boolean;
      payload?: Uint8Array;
    } = {},
  ): Promise<UsbExchange> {
    const requestId = this.#nextId++;
    const headers = { ...options.headers };
    if (options.auth !== false && this.token) headers.authorization = `Bearer ${this.token}`;
    const json: UsbRequestJson = { m: method, p: path };
    if (Object.keys(headers).length > 0) json.h = headers;
    if (options.body !== undefined) json.b = options.body;
    await this.channel.write(
      encodeFrame({
        kind: FrameKind.Request,
        requestId,
        json,
        payload: options.payload,
      }),
    );
    const headerBytes = await this.channel.readExact(USB_FRAME_HEADER_SIZE);
    const header = decodeFrameHeader(headerBytes);
    const jsonBytes = header.jsonLength
      ? await this.channel.readExact(header.jsonLength)
      : new Uint8Array(0);
    const payload = header.payloadLength
      ? await this.channel.readExact(header.payloadLength)
      : new Uint8Array(0);
    const parsed: UsbResponseJson = jsonBytes.byteLength
      ? (JSON.parse(new TextDecoder().decode(jsonBytes)) as UsbResponseJson)
      : {};
    const err = (parsed.b as { error?: { code?: string; msg?: string } } | undefined)?.error;
    if (header.status >= 400) {
      throw new DeviceApiError(
        header.status,
        err?.code ?? "INTERNAL",
        err?.msg ?? `USB error (${header.status})`,
      );
    }
    if (header.requestId !== requestId) {
      throw new Error(`USB response id ${header.requestId} != request ${requestId}`);
    }
    return { status: header.status, json: parsed, payload };
  }
}
