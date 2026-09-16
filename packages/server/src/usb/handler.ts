import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  CatalogQuerySchema,
  CreateJobRequestSchema,
  DeviceInfoSchema,
  DeviceStateSchema,
  ERROR_HTTP_STATUS,
  EventsQuerySchema,
  JobCompleteRequestSchema,
  JobProgressRequestSchema,
  PairRequestSchema,
  type UsbRequestJson,
} from "@nslib/shared";
import type { UsbHandlerResult, UsbRequestHandler } from "@nslib/usb-host";
import { ApiError, parseWith } from "../api/errors";
import type { DeviceRow } from "../db/schema";
import { etagFor, etagsMatch, parseRangeHeader } from "../device/range";
import type { DeviceApiService } from "../device/service";

const STREAM_CHUNK = 1024 * 1024;

function headerOf(req: UsbRequestJson, name: string): string | undefined {
  if (!req.h) return undefined;
  const key = Object.keys(req.h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? req.h[key] : undefined;
}

function bearer(req: UsbRequestJson): string | undefined {
  const raw = headerOf(req, "authorization");
  if (!raw?.toLowerCase().startsWith("bearer ")) return undefined;
  return raw.slice(7).trim();
}

function pathParts(path: string): { path: string; query: URLSearchParams } {
  const q = path.indexOf("?");
  if (q === -1) return { path, query: new URLSearchParams() };
  return { path: path.slice(0, q), query: new URLSearchParams(path.slice(q + 1)) };
}

async function readRange(absolutePath: string, start: number, length: number): Promise<Uint8Array> {
  if (length <= STREAM_CHUNK) {
    const fh = await import("node:fs/promises").then((m) => m.open(absolutePath, "r"));
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, start);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(absolutePath, { start, end: start + length - 1 });
    stream.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

export class DeviceUsbHandler implements UsbRequestHandler {
  #device: DeviceRow | null = null;
  #token: string | undefined;

  constructor(
    private readonly devices: DeviceApiService,
    private readonly iconDir: string,
  ) {}

  onDetach(): void {
    if (this.#device) this.devices.interruptActiveJobs(this.#device.id, "USB disconnected");
    this.#device = null;
    this.#token = undefined;
  }

  async handle(
    req: UsbRequestJson,
    _payload: Uint8Array,
    _requestId?: number,
  ): Promise<UsbHandlerResult> {
    const { path, query } = pathParts(req.p);
    const method = req.m.toUpperCase();
    try {
      if (method === "POST" && path === "/usb/hello") {
        return this.#hello(req);
      }
      if (method === "POST" && path === "/pair") {
        const body = parseWith(PairRequestSchema, req.b);
        const paired = this.devices.pair(body, "usb");
        this.#token = paired.token;
        this.#device = this.devices.requireActive(this.devices.resolveToken(paired.token));
        return { status: 200, body: paired };
      }

      const token = bearer(req) ?? this.#token;
      this.#device = this.devices.requireActive(this.devices.resolveToken(token));
      this.devices.touch(this.#device.id, "usb");
      this.#token = token;

      if (method === "GET" && path === "/hello") {
        return { status: 200, body: this.devices.hello() };
      }
      if (method === "PUT" && path === "/state") {
        this.devices.updateState(this.#device.id, parseWith(DeviceStateSchema, req.b));
        return { status: 204 };
      }
      if (method === "GET" && path === "/catalog") {
        const catalog = this.devices.getCatalog(
          parseWith(CatalogQuerySchema, {
            since: query.get("since") ?? undefined,
            cursor: query.get("cursor") ?? undefined,
            limit: query.get("limit") ?? undefined,
          }),
        );
        return { status: 200, body: catalog };
      }
      if (method === "GET" && path.startsWith("/icons/")) {
        return this.#icon(path.slice("/icons/".length).split("?")[0] ?? "");
      }
      if (method === "GET" && path.startsWith("/files/")) {
        return this.#file(
          Number(path.slice("/files/".length)),
          headerOf(req, "range"),
          headerOf(req, "if-range"),
          headerOf(req, "if-match"),
        );
      }
      if (method === "GET" && path === "/events") {
        const events = await this.devices.pollEvents(
          this.#device,
          parseWith(EventsQuerySchema, {
            cursor: query.get("cursor") ?? undefined,
            wait: query.get("wait") ?? undefined,
          }),
        );
        return { status: 200, body: events };
      }
      if (method === "POST" && path === "/jobs") {
        const body = parseWith(CreateJobRequestSchema, req.b);
        const job = this.devices.createJobFromDevice(
          this.#device.id,
          body.contentMetaId,
          body.target,
        );
        return { status: 201, body: job };
      }
      const claim = /^\/jobs\/(\d+)\/claim$/.exec(path);
      if (method === "POST" && claim?.[1]) {
        const job = this.devices.claimJob(this.#device.id, Number(claim[1]));
        return { status: 200, body: { job } };
      }
      const progress = /^\/jobs\/(\d+)\/progress$/.exec(path);
      if (method === "POST" && progress?.[1]) {
        this.devices.progress(
          this.#device.id,
          Number(progress[1]),
          parseWith(JobProgressRequestSchema, req.b),
        );
        return { status: 204 };
      }
      const complete = /^\/jobs\/(\d+)\/complete$/.exec(path);
      if (method === "POST" && complete?.[1]) {
        this.devices.complete(
          this.#device.id,
          Number(complete[1]),
          parseWith(JobCompleteRequestSchema, req.b),
        );
        return { status: 204 };
      }
      throw new ApiError("NOT_FOUND", `No USB route for ${method} ${path}`);
    } catch (err) {
      if (err instanceof ApiError) {
        return {
          status: err.status,
          body: { error: { code: err.code, msg: err.message } },
        };
      }
      throw err;
    }
  }

  #hello(req: UsbRequestJson): UsbHandlerResult {
    const info = parseWith(DeviceInfoSchema, req.b ?? req);
    const token = bearer(req) ?? this.#token;
    const paired = this.devices.usbHello(info, token);
    this.#token = paired.token;
    this.#device = this.devices.requireActive(this.devices.resolveToken(paired.token));
    return { status: 200, body: paired };
  }

  async #icon(appId: string): Promise<UsbHandlerResult> {
    const key = this.devices.iconKey(appId.toUpperCase());
    if (!key) throw new ApiError("NOT_FOUND", "No icon for this title");
    const path = join(this.iconDir, `${key}.jpg`);
    try {
      await stat(path);
    } catch {
      throw new ApiError("NOT_FOUND", "No icon for this title");
    }
    const payload = await readFile(path);
    return {
      status: 200,
      headers: { "content-type": "image/jpeg" },
      payload,
    };
  }

  async #file(
    fileId: number,
    rangeHeader: string | undefined,
    ifRange: string | undefined,
    ifMatch: string | undefined,
  ): Promise<UsbHandlerResult> {
    const located = this.devices.locateLibraryFile(fileId);
    let disk: { size: number; mtimeMs: number };
    try {
      const info = await stat(located.absolutePath);
      disk = { size: info.size, mtimeMs: Math.floor(info.mtimeMs) };
    } catch {
      throw new ApiError("FILE_MISSING", "This file is no longer on disk");
    }
    const etag = etagFor(disk.size, disk.mtimeMs);
    if (ifMatch && ifMatch !== "*" && !etagsMatch(ifMatch, etag)) {
      throw new ApiError("FILE_CHANGED", "The file changed since it was listed");
    }
    const useRange = !ifRange || etagsMatch(ifRange, etag);
    const parsed = useRange ? parseRangeHeader(rangeHeader, disk.size) : "all";
    if (parsed === "unsatisfiable") {
      return {
        status: ERROR_HTTP_STATUS.RANGE_NOT_SATISFIABLE,
        headers: { "content-range": `bytes */${disk.size}` },
        body: {
          error: { code: "RANGE_NOT_SATISFIABLE", msg: "Requested range is outside the file" },
        },
      };
    }
    const range = parsed === "all" ? { start: 0, end: Math.max(0, disk.size - 1) } : parsed;
    const length = disk.size === 0 ? 0 : range.end - range.start + 1;
    const payload =
      length === 0 ? new Uint8Array(0) : await readRange(located.absolutePath, range.start, length);
    const headers: Record<string, string> = {
      etag,
      "accept-ranges": "bytes",
    };
    const status = parsed === "all" ? 200 : 206;
    if (parsed !== "all")
      headers["content-range"] = `bytes ${range.start}-${range.end}/${disk.size}`;
    return { status, headers, payload };
  }
}
