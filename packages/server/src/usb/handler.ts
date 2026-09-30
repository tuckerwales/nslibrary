import { open, readFile, stat } from "node:fs/promises";
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
  SaveListQuerySchema,
  SaveUploadQuerySchema,
  type UsbRequestJson,
} from "@nslib/shared";
import type { UsbHandlerResult, UsbRequestHandler, UsbStreamPayload } from "@nslib/usb-host";
import { ApiError, parseWith } from "../api/errors";
import type { DeviceRow } from "../db/schema";
import { etagFor, etagsMatch, parseRangeHeader } from "../device/range";
import type { DeviceApiService } from "../device/service";
import type { LocatedLibraryFile } from "../library/library-fs";
import { openLocatedFile } from "../library/library-fs";
import type { SaveService } from "../saves/service";

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

const STREAM_CHUNK = 1024 * 1024;

/** Streams a byte range 1 MiB at a time, so a whole-file request doesn't load the file. */
function rangeStream(located: LocatedLibraryFile, start: number, length: number): UsbStreamPayload {
  return {
    length,
    chunks: (async function* () {
      const source = await openLocatedFile(located);
      try {
        for (let done = 0; done < length; ) {
          const chunk = await source.read(start + done, Math.min(STREAM_CHUNK, length - done));
          if (chunk.byteLength === 0) throw new Error("The file got shorter while it was sent");
          done += chunk.byteLength;
          yield new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        }
      } finally {
        await source.close();
      }
    })(),
  };
}

/** Streams part of a save archive, like `rangeStream` does for library files. */
function archiveStream(path: string, start: number, length: number): UsbStreamPayload {
  return {
    length,
    chunks: (async function* () {
      const handle = await open(path, "r");
      try {
        for (let done = 0; done < length; ) {
          const buffer = Buffer.allocUnsafe(Math.min(STREAM_CHUNK, length - done));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, start + done);
          if (bytesRead === 0) throw new Error("The save archive got shorter while it was sent");
          done += bytesRead;
          yield new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
        }
      } finally {
        await handle.close();
      }
    })(),
  };
}

export class DeviceUsbHandler implements UsbRequestHandler {
  #device: DeviceRow | null = null;
  #token: string | undefined;

  constructor(
    private readonly devices: DeviceApiService,
    private readonly iconDir: string,
    private readonly saves: SaveService,
  ) {}

  onDetach(): void {
    if (this.#device) this.devices.interruptActiveJobs(this.#device.id, "USB disconnected");
    this.#device = null;
    this.#token = undefined;
  }

  async handle(
    req: UsbRequestJson,
    payload: Uint8Array | UsbStreamPayload,
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
        return { status: 200, body: this.devices.hello(this.#device.id) };
      }
      if (method === "GET" && path === "/update") {
        const nroPath = this.devices.nroPath();
        if (!nroPath)
          throw new ApiError("NOT_FOUND", "No Switch app update is available on this server");
        const payload = await readFile(nroPath);
        return {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
          payload,
        };
      }
      if (method === "GET" && (path === "/update/manifest" || path === "/update/signature")) {
        const file = this.devices.updateFilePath(
          path === "/update/manifest" ? "manifest" : "signature",
        );
        const missing = new ApiError(
          "NOT_FOUND",
          "The Switch app on this server has no update.json signature. Copy update.json and update.json.sig from the GitHub release next to the .nro.",
        );
        if (!file) throw missing;
        let payload: Buffer;
        try {
          payload = await readFile(file);
        } catch {
          throw missing;
        }
        return {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
          payload,
        };
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
      if (method === "GET" && path === "/saves") {
        const q = parseWith(SaveListQuerySchema, {
          app: query.get("app") ?? undefined,
          latest: query.get("latest") ?? undefined,
        });
        const rows = this.saves.list({ applicationId: q.app, latest: q.latest === "1" });
        return { status: 200, body: { backups: this.saves.toDevice(rows, this.#device.id) } };
      }
      if (method === "POST" && path === "/saves") {
        const q = parseWith(SaveUploadQuerySchema, Object.fromEntries(query));
        // A large upload is streamed off the link to disk, never held in memory.
        const stored =
          payload instanceof Uint8Array
            ? await this.saves.store(payload, q, this.#device, payload.byteLength)
            : await this.saves.store(payload.chunks, q, this.#device, payload.length);
        const [backup] = this.saves.toDevice([stored.row], this.#device.id);
        return { status: stored.dup ? 200 : 201, body: { backup, dup: stored.dup } };
      }
      const saveData = /^\/saves\/(\d+)\/data$/.exec(path);
      if (method === "GET" && saveData?.[1]) {
        return this.#saveArchive(
          Number(saveData[1]),
          headerOf(req, "range"),
          headerOf(req, "if-range"),
        );
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

  async #saveArchive(
    id: number,
    rangeHeader: string | undefined,
    ifRange: string | undefined,
  ): Promise<UsbHandlerResult> {
    const located = await this.saves.locate(id);
    const etag = `"${located.row.sha256}"`;
    const useRange = !ifRange || etagsMatch(ifRange, etag);
    const parsed = useRange ? parseRangeHeader(rangeHeader, located.size) : "all";
    if (parsed === "unsatisfiable") {
      return {
        status: ERROR_HTTP_STATUS.RANGE_NOT_SATISFIABLE,
        headers: { "content-range": `bytes */${located.size}` },
        body: {
          error: { code: "RANGE_NOT_SATISFIABLE", msg: "Requested range is outside the archive" },
        },
      };
    }
    const range = parsed === "all" ? { start: 0, end: located.size - 1 } : parsed;
    const length = located.size === 0 ? 0 : range.end - range.start + 1;
    const headers: Record<string, string> = { etag, "accept-ranges": "bytes" };
    if (parsed !== "all") {
      headers["content-range"] = `bytes ${range.start}-${range.end}/${located.size}`;
    }
    return {
      status: parsed === "all" ? 200 : 206,
      headers,
      payload: length === 0 ? new Uint8Array(0) : archiveStream(located.path, range.start, length),
    };
  }

  async #file(
    fileId: number,
    rangeHeader: string | undefined,
    ifRange: string | undefined,
    ifMatch: string | undefined,
  ): Promise<UsbHandlerResult> {
    const located = await this.devices.locateLibraryFile(fileId);
    const disk = { size: located.size, mtimeMs: located.mtimeMs };
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
    const payload = length === 0 ? new Uint8Array(0) : rangeStream(located, range.start, length);
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
