import { createHash } from "node:crypto";
import {
  type CatalogQuery,
  type CatalogResponse,
  DEVICE_API_BASE_PATH,
  type DeviceState,
  type EventsQuery,
  type EventsResponse,
  type HelloResponse,
  type Job,
  type JobCompleteRequest,
  type JobProgressRequest,
  type PairRequest,
  type PairResponse,
  type SaveListResponse,
  type SaveOrigin,
  type SaveType,
  type SaveUploadResponse,
} from "@nslib/shared";

export interface SaveUploadOptions {
  app: string;
  type: SaveType;
  user?: string;
  userName?: string;
  name?: string;
  origin?: SaveOrigin;
  /** Defaults to the archive's real hash; tests pass a wrong one on purpose. */
  sha256?: string;
}

/** The query string of `POST /saves`, shared by the HTTP and USB clients. */
export function saveUploadPath(archive: Uint8Array, options: SaveUploadOptions): string {
  const params = new URLSearchParams({ app: options.app, type: options.type });
  if (options.user !== undefined) params.set("user", options.user);
  if (options.userName !== undefined) params.set("userName", options.userName);
  if (options.name !== undefined) params.set("name", options.name);
  if (options.origin !== undefined) params.set("origin", options.origin);
  params.set("sha256", options.sha256 ?? createHash("sha256").update(archive).digest("hex"));
  return `/saves?${params}`;
}

export class DeviceApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "DeviceApiError";
    this.status = status;
    this.code = code;
  }
}

export class DeviceClient {
  constructor(
    public baseUrl: string,
    public token?: string,
  ) {}

  async pair(body: PairRequest): Promise<PairResponse> {
    const response = await this.json<PairResponse>("POST", "/pair", { body, auth: false });
    this.token = response.token;
    return response;
  }

  hello(): Promise<HelloResponse> {
    return this.json("GET", "/hello");
  }

  putState(body: DeviceState): Promise<void> {
    return this.json("PUT", "/state", { body, empty: true });
  }

  catalog(query: CatalogQuery = {}): Promise<CatalogResponse> {
    const params = new URLSearchParams();
    if (query.since !== undefined) params.set("since", String(query.since));
    if (query.cursor) params.set("cursor", query.cursor);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const suffix = params.size > 0 ? `?${params}` : "";
    return this.json("GET", `/catalog${suffix}`);
  }

  events(query: EventsQuery = {}, signal?: AbortSignal): Promise<EventsResponse> {
    const params = new URLSearchParams();
    if (query.cursor !== undefined) params.set("cursor", query.cursor);
    if (query.wait !== undefined) params.set("wait", String(query.wait));
    const suffix = params.size > 0 ? `?${params}` : "";
    return this.json("GET", `/events${suffix}`, { signal });
  }

  createJob(contentMetaId: number, target: Job["target"] = "auto"): Promise<Job> {
    return this.json("POST", "/jobs", { body: { contentMetaId, target } });
  }

  async claimJob(id: number): Promise<Job> {
    const response = await this.json<{ job: Job }>("POST", `/jobs/${id}/claim`);
    return response.job;
  }

  progress(id: number, body: JobProgressRequest): Promise<void> {
    return this.json("POST", `/jobs/${id}/progress`, { body, empty: true });
  }

  complete(id: number, body: JobCompleteRequest): Promise<void> {
    return this.json("POST", `/jobs/${id}/complete`, { body, empty: true });
  }

  getFile(
    fileId: number,
    options: { range?: string; ifRange?: string; ifMatch?: string } = {},
  ): Promise<Response> {
    return this.fetch("GET", `/files/${fileId}`, options);
  }

  listSaves(query: { app?: string; latest?: boolean } = {}): Promise<SaveListResponse> {
    const params = new URLSearchParams();
    if (query.app) params.set("app", query.app);
    if (query.latest) params.set("latest", "1");
    const suffix = params.size > 0 ? `?${params}` : "";
    return this.json("GET", `/saves${suffix}`);
  }

  uploadSave(archive: Uint8Array, options: SaveUploadOptions): Promise<SaveUploadResponse> {
    return this.json("POST", saveUploadPath(archive, options), { raw: archive });
  }

  downloadSave(id: number, options: { range?: string } = {}): Promise<Response> {
    return this.fetch("GET", `/saves/${id}/data`, options);
  }

  getIcon(appId: string, revision?: number): Promise<Response> {
    const suffix = revision === undefined ? "" : `?v=${revision}`;
    return this.fetch("GET", `/icons/${appId}${suffix}`);
  }

  private async json<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      raw?: Uint8Array;
      auth?: boolean;
      empty?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    const response = await this.fetch(method, path, options);
    if (options.empty && (response.status === 204 || response.status === 200)) {
      return undefined as T;
    }
    const data = (await response.json().catch(() => null)) as {
      error?: { code?: string; msg?: string };
    } | null;
    if (!response.ok) {
      throw new DeviceApiError(
        response.status,
        data?.error?.code ?? "INTERNAL",
        data?.error?.msg ?? `Device API error (${response.status})`,
      );
    }
    return data as T;
  }

  private async fetch(
    method: string,
    path: string,
    options: {
      body?: unknown;
      /** A save archive, sent as application/x-tar instead of a JSON body. */
      raw?: Uint8Array;
      auth?: boolean;
      range?: string;
      ifRange?: string;
      ifMatch?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (options.auth !== false && this.token) headers.authorization = `Bearer ${this.token}`;
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.raw !== undefined) headers["content-type"] = "application/x-tar";
    if (options.range) headers.range = options.range;
    if (options.ifRange) headers["if-range"] = options.ifRange;
    if (options.ifMatch) headers["if-match"] = options.ifMatch;
    return fetch(`${this.baseUrl.replace(/\/$/, "")}${DEVICE_API_BASE_PATH}${path}`, {
      method,
      headers,
      body:
        options.raw !== undefined
          ? options.raw
          : options.body === undefined
            ? undefined
            : JSON.stringify(options.body),
      signal: options.signal,
    });
  }
}
