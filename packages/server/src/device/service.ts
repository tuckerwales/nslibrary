import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import {
  applicationIdForPatch,
  type CatalogQuery,
  type CatalogResponse,
  DEVICE_API_PROTOCOL_VERSION,
  DEVICE_CAPABILITIES,
  type DeviceInfo,
  type DeviceState,
  type EventsResponse,
  guessApplicationIdForAddon,
  type HelloResponse,
  type InstallTarget,
  type Job,
  type JobCompleteRequest,
  type JobProgressRequest,
  type PairingCode,
  type PairRequest,
  type PairResponse,
  type ServerSettings,
  type WebJob,
} from "@nslib/shared";
import { and, eq, inArray, lt } from "drizzle-orm";
import { ApiError } from "../api/errors";
import type { Db } from "../db/client";
import {
  applications,
  contentMetas,
  type DeviceRow,
  devices,
  deviceTitles,
  files,
  installJobs,
  type JobRow,
  libraryRoots,
  pairingCodes,
  settings,
} from "../db/schema";
import type { EventBus } from "../events";
import { buildCatalogApps, paginateCatalog } from "./catalog";
import { DeviceEventLog } from "./events";

export const PREFER_NSZ_KEY = "prefer_nsz";
export const SERVER_ID_KEY = "server_id";
export const REQUIRE_USB_PAIRING_KEY = "require_usb_pairing";

const PAIR_TTL_MS = 5 * 60 * 1000;
const PAIR_MAX_ATTEMPTS = 5;
const ONLINE_AFTER_MS = 60_000;
const PROGRESS_MIN_INTERVAL_MS = 1000;
const JOB_EVENT_MIN_INTERVAL_MS = 500;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function setting(db: Db, key: string): string | null {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null;
}

function putSetting(db: Db, key: string, value: string): void {
  db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}

function applicationIdFor(titleId: string, type: JobRow["type"]): string {
  if (type === "application") return titleId;
  if (type === "patch") return applicationIdForPatch(titleId);
  return guessApplicationIdForAddon(titleId);
}

export interface DeviceApiOptions {
  db: Db;
  events: EventBus;
  now?: () => number;
  serverName: string;
  catalogRev: () => number;
}

export class DeviceApiService {
  readonly log = new DeviceEventLog();
  readonly #db: Db;
  readonly #events: EventBus;
  readonly #now: () => number;
  readonly #serverName: string;
  readonly #catalogRev: () => number;
  readonly #waiters = new Map<number, number>();
  readonly #lastProgressAt = new Map<number, number>();
  readonly #lastJobEventAt = new Map<number, number>();
  readonly #pendingJobEvent = new Map<number, ReturnType<typeof setTimeout>>();
  #serverId: string;

  constructor(options: DeviceApiOptions) {
    this.#db = options.db;
    this.#events = options.events;
    this.#now = options.now ?? Date.now;
    this.#serverName = options.serverName;
    this.#catalogRev = options.catalogRev;
    this.#serverId = this.#loadOrCreateServerId();
    this.#events.subscribe((event) => {
      if (event.type === "library.changed") {
        this.log.append(null, { t: "catalog", rev: event.rev });
      }
    });
  }

  get serverId(): string {
    return this.#serverId;
  }

  get serverName(): string {
    return setting(this.#db, "server_name") ?? this.#serverName;
  }

  preferNsz(): boolean {
    return setting(this.#db, PREFER_NSZ_KEY) !== "0";
  }

  requireUsbPairing(): boolean {
    return setting(this.#db, REQUIRE_USB_PAIRING_KEY) === "1";
  }

  getSettings(): ServerSettings {
    return {
      preferNsz: this.preferNsz(),
      serverName: this.serverName,
      requireUsbPairing: this.requireUsbPairing(),
    };
  }

  updateSettings(patch: {
    preferNsz?: boolean;
    serverName?: string;
    requireUsbPairing?: boolean;
  }): ServerSettings {
    if (patch.preferNsz !== undefined)
      putSetting(this.#db, PREFER_NSZ_KEY, patch.preferNsz ? "1" : "0");
    if (patch.serverName !== undefined) putSetting(this.#db, "server_name", patch.serverName);
    if (patch.requireUsbPairing !== undefined) {
      putSetting(this.#db, REQUIRE_USB_PAIRING_KEY, patch.requireUsbPairing ? "1" : "0");
    }
    return this.getSettings();
  }

  createPairingCode(): PairingCode {
    const now = this.#now();
    this.#db.delete(pairingCodes).where(lt(pairingCodes.id, Number.MAX_SAFE_INTEGER)).run();
    const code = randomBytes(4).readUInt32BE(0) % 1_000_000;
    const digits = code.toString().padStart(6, "0");
    const expiresAt = now + PAIR_TTL_MS;
    this.#db
      .insert(pairingCodes)
      .values({
        codeHash: sha256Hex(digits),
        expiresAt,
        attempts: 0,
        createdAt: now,
      })
      .run();
    return { code: digits, expiresAt };
  }

  pair(body: PairRequest, transport: DeviceRow["transport"] = "http"): PairResponse {
    const now = this.#now();
    const row = this.#db.select().from(pairingCodes).orderBy(pairingCodes.createdAt).all().at(-1);
    if (!row)
      throw new ApiError(
        "PAIR_CODE_INVALID",
        "No pairing code is active. Generate one in the web UI.",
      );
    if (row.expiresAt <= now) {
      this.#db.delete(pairingCodes).where(eq(pairingCodes.id, row.id)).run();
      throw new ApiError("PAIR_CODE_EXPIRED", "Pairing code has expired");
    }
    if (row.attempts >= PAIR_MAX_ATTEMPTS) {
      throw new ApiError("PAIR_RATE_LIMITED", "Too many attempts. Generate a new pairing code.");
    }
    if (!hashesEqual(row.codeHash, sha256Hex(body.code))) {
      const attempts = row.attempts + 1;
      this.#db.update(pairingCodes).set({ attempts }).where(eq(pairingCodes.id, row.id)).run();
      if (attempts >= PAIR_MAX_ATTEMPTS) {
        throw new ApiError("PAIR_RATE_LIMITED", "Too many attempts. Generate a new pairing code.");
      }
      throw new ApiError("PAIR_CODE_INVALID", "That pairing code is wrong");
    }

    this.#db.delete(pairingCodes).where(eq(pairingCodes.id, row.id)).run();
    const token = randomBytes(32).toString("base64url");
    const tokenHash = sha256Hex(token);
    const existing = this.#db.select().from(devices).where(eq(devices.uuid, body.deviceUuid)).get();
    const values = {
      name: body.name,
      tokenHash,
      fw: body.fw,
      ams: body.amsVersion,
      appVersion: body.appVersion,
      lastSeen: now,
      transport,
      revokedAt: null as number | null,
    };

    let deviceId: number;
    if (existing) {
      this.#db.update(devices).set(values).where(eq(devices.id, existing.id)).run();
      deviceId = existing.id;
    } else {
      deviceId = this.#db
        .insert(devices)
        .values({ uuid: body.deviceUuid, createdAt: now, ...values })
        .returning({ id: devices.id })
        .get().id;
    }

    this.#events.publish({ type: "device.paired", deviceId, name: body.name });
    return {
      token,
      deviceId,
      serverId: this.#serverId,
      serverName: this.serverName,
    };
  }

  /**
   * First USB request. Trusts the Switch automatically unless Settings requires pairing.
   * A valid existing token is always accepted.
   */
  usbHello(info: DeviceInfo, token?: string): PairResponse {
    const now = this.#now();
    if (token) {
      const device = this.requireActive(this.resolveToken(token));
      this.#db
        .update(devices)
        .set({
          name: info.name,
          fw: info.fw,
          ams: info.amsVersion,
          appVersion: info.appVersion,
          lastSeen: now,
          transport: "usb",
        })
        .where(eq(devices.id, device.id))
        .run();
      return {
        token,
        deviceId: device.id,
        serverId: this.#serverId,
        serverName: this.serverName,
      };
    }
    if (this.requireUsbPairing()) {
      throw new ApiError("UNAUTHORIZED", "Pair this Switch before continuing");
    }
    const newToken = randomBytes(32).toString("base64url");
    const tokenHash = sha256Hex(newToken);
    const existing = this.#db.select().from(devices).where(eq(devices.uuid, info.deviceUuid)).get();
    const values = {
      name: info.name,
      tokenHash,
      fw: info.fw,
      ams: info.amsVersion,
      appVersion: info.appVersion,
      lastSeen: now,
      transport: "usb" as const,
      revokedAt: null as number | null,
    };
    let deviceId: number;
    if (existing) {
      this.#db.update(devices).set(values).where(eq(devices.id, existing.id)).run();
      deviceId = existing.id;
    } else {
      deviceId = this.#db
        .insert(devices)
        .values({ uuid: info.deviceUuid, createdAt: now, ...values })
        .returning({ id: devices.id })
        .get().id;
    }
    this.#events.publish({ type: "device.paired", deviceId, name: info.name });
    return {
      token: newToken,
      deviceId,
      serverId: this.#serverId,
      serverName: this.serverName,
    };
  }

  interruptActiveJobs(deviceId: number, message: string): void {
    this.#interruptActiveJobs(deviceId, message);
  }

  resolveToken(token: string | undefined): DeviceRow | null {
    if (!token) return null;
    const device = this.#db
      .select()
      .from(devices)
      .where(eq(devices.tokenHash, sha256Hex(token)))
      .get();
    return device ?? null;
  }

  requireActive(device: DeviceRow | null): DeviceRow {
    if (!device) throw new ApiError("UNAUTHORIZED", "Pair this Switch before continuing");
    if (device.revokedAt !== null) {
      throw new ApiError("DEVICE_REVOKED", "This Switch was revoked. Pair it again.");
    }
    return device;
  }

  touch(deviceId: number, transport?: DeviceRow["transport"]): void {
    this.#db
      .update(devices)
      .set({ lastSeen: this.#now(), ...(transport ? { transport } : {}) })
      .where(eq(devices.id, deviceId))
      .run();
  }

  hello(): HelloResponse {
    return {
      serverId: this.#serverId,
      serverName: this.serverName,
      proto: DEVICE_API_PROTOCOL_VERSION,
      catalogRev: this.#catalogRev(),
      caps: [...DEVICE_CAPABILITIES],
    };
  }

  updateState(deviceId: number, state: DeviceState): void {
    const now = this.#now();
    this.#db.transaction(() => {
      this.#db
        .update(devices)
        .set({
          fw: state.fw,
          ams: state.ams,
          lastSeen: now,
          sdFree: state.space.sd?.[0] ?? null,
          sdTotal: state.space.sd?.[1] ?? null,
          nandFree: state.space.nand[0],
          nandTotal: state.space.nand[1],
        })
        .where(eq(devices.id, deviceId))
        .run();
      this.#db.delete(deviceTitles).where(eq(deviceTitles.deviceId, deviceId)).run();
      if (state.titles.length === 0) return;
      this.#db
        .insert(deviceTitles)
        .values(
          state.titles.map(([titleId, version, type, storage]) => ({
            deviceId,
            storage,
            titleId,
            version,
            type,
            applicationId: type === "application" ? titleId : applicationIdFor(titleId, type),
          })),
        )
        .run();
    });
  }

  getCatalog(query: CatalogQuery): CatalogResponse {
    const apps = buildCatalogApps(this.#db, this.preferNsz());
    return paginateCatalog(apps, this.#catalogRev(), query);
  }

  iconKey(applicationId: string): string | null {
    return (
      this.#db
        .select({ iconKey: applications.iconKey })
        .from(applications)
        .where(eq(applications.applicationId, applicationId))
        .get()?.iconKey ?? null
    );
  }

  locateLibraryFile(fileId: number): { absolutePath: string; size: number; mtimeMs: number } {
    const file = this.#db.select().from(files).where(eq(files.id, fileId)).get();
    const root =
      file && this.#db.select().from(libraryRoots).where(eq(libraryRoots.id, file.rootId)).get();
    if (!file || !root) throw new ApiError("NOT_FOUND", "That file is no longer in the library");
    if (file.missingSince !== null) {
      throw new ApiError("FILE_MISSING", "This file is no longer on disk");
    }
    return {
      absolutePath: join(root.path, ...file.relPath.split("/")),
      size: file.size,
      mtimeMs: file.mtimeMs,
    };
  }

  listDevices(): ReturnType<DeviceApiService["toSummary"]>[] {
    return this.#db
      .select()
      .from(devices)
      .all()
      .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id)
      .map((row) => this.toSummary(row));
  }

  getDevice(id: number) {
    const row = this.#requireDeviceRow(id);
    const titles = this.#db.select().from(deviceTitles).where(eq(deviceTitles.deviceId, id)).all();
    return {
      ...this.toSummary(row),
      titles: titles.map((title) => ({
        titleId: title.titleId,
        version: title.version,
        type: title.type,
        storage: title.storage,
      })),
    };
  }

  renameDevice(id: number, name: string) {
    this.#requireDeviceRow(id);
    this.#db.update(devices).set({ name }).where(eq(devices.id, id)).run();
    return this.getDevice(id);
  }

  revokeDevice(id: number) {
    const row = this.#requireDeviceRow(id);
    if (row.revokedAt === null) {
      this.#db.update(devices).set({ revokedAt: this.#now() }).where(eq(devices.id, id)).run();
      this.#interruptActiveJobs(id, "This Switch was revoked");
    }
    return this.getDevice(id);
  }

  createJobs(deviceId: number, contentMetaIds: number[], target: InstallTarget): WebJob[] {
    this.#requireActiveDevice(deviceId);
    const jobs: WebJob[] = [];
    this.#db.transaction(() => {
      let position = this.#nextPosition(deviceId);
      for (const contentMetaId of contentMetaIds) {
        const job = this.#insertJob(deviceId, contentMetaId, target, position);
        position += 1;
        jobs.push(job);
      }
    });
    for (const job of jobs) {
      this.log.append(deviceId, { t: "job.queued", job: this.toDeviceJob(job) });
      this.#publishJob(job);
    }
    return jobs;
  }

  createJobFromDevice(deviceId: number, contentMetaId: number, target: InstallTarget): Job {
    const job = this.#insertJob(deviceId, contentMetaId, target, this.#nextPosition(deviceId));
    this.log.append(deviceId, { t: "job.queued", job: this.toDeviceJob(job) });
    this.#publishJob(job);
    return this.toDeviceJob(job);
  }

  claimJob(deviceId: number, jobId: number): Job {
    const row = this.#jobForDevice(deviceId, jobId);
    if (row.status !== "queued") {
      throw new ApiError("JOB_INVALID_STATE", "That job is no longer waiting to be claimed");
    }
    const now = this.#now();
    const updated = this.#db
      .update(installJobs)
      .set({ status: "claimed", claimedAt: now, updatedAt: now })
      .where(eq(installJobs.id, jobId))
      .returning()
      .get();
    const job = this.toWebJob(updated);
    this.#publishJob(job);
    return this.toDeviceJob(job);
  }

  progress(deviceId: number, jobId: number, body: JobProgressRequest): void {
    const row = this.#jobForDevice(deviceId, jobId);
    if (row.status !== "claimed" && row.status !== "running") {
      throw new ApiError("JOB_INVALID_STATE", "Progress can only be reported for an active job");
    }
    const now = this.#now();
    const last = this.#lastProgressAt.get(jobId) ?? 0;
    if (now - last < PROGRESS_MIN_INTERVAL_MS && row.phase === body.phase) return;
    this.#lastProgressAt.set(jobId, now);
    const updated = this.#db
      .update(installJobs)
      .set({
        status: "running",
        phase: body.phase,
        item: body.item ?? null,
        bytesDone: body.done,
        bps: Math.round(body.bps),
        updatedAt: now,
      })
      .where(eq(installJobs.id, jobId))
      .returning()
      .get();
    this.#publishJob(this.toWebJob(updated), true);
  }

  complete(deviceId: number, jobId: number, body: JobCompleteRequest): WebJob {
    const row = this.#jobForDevice(deviceId, jobId);
    if (row.status !== "claimed" && row.status !== "running") {
      throw new ApiError("JOB_INVALID_STATE", "That job is not running");
    }
    const now = this.#now();
    const updated = this.#db
      .update(installJobs)
      .set({
        status: body.ok ? "done" : "failed",
        error: body.ok ? null : (body.msg ?? body.result ?? "Install failed"),
        updatedAt: now,
        completedAt: now,
        bytesDone: body.ok ? row.size : row.bytesDone,
      })
      .where(eq(installJobs.id, jobId))
      .returning()
      .get();
    const job = this.toWebJob(updated);
    this.#publishJob(job);
    return job;
  }

  cancelJob(jobId: number): WebJob {
    const row = this.#requireJob(jobId);
    if (
      row.status === "done" ||
      row.status === "failed" ||
      row.status === "cancelled" ||
      row.status === "interrupted"
    ) {
      throw new ApiError("JOB_INVALID_STATE", "That job has already finished");
    }
    const now = this.#now();
    const updated = this.#db
      .update(installJobs)
      .set({ status: "cancelled", updatedAt: now, completedAt: now, error: "Cancelled" })
      .where(eq(installJobs.id, jobId))
      .returning()
      .get();
    const job = this.toWebJob(updated);
    this.log.append(row.deviceId, { t: "job.cancel", id: jobId });
    this.#publishJob(job);
    return job;
  }

  reorderJobs(deviceId: number, ids: number[]): WebJob[] {
    this.#requireActiveDevice(deviceId);
    const queued = this.#db
      .select()
      .from(installJobs)
      .where(and(eq(installJobs.deviceId, deviceId), eq(installJobs.status, "queued")))
      .all();
    const byId = new Map(queued.map((row) => [row.id, row]));
    if (ids.length !== queued.length || ids.some((id) => !byId.has(id))) {
      throw new ApiError(
        "BAD_REQUEST",
        "The list must include every queued job for this Switch, and only those.",
      );
    }
    this.#db.transaction(() => {
      ids.forEach((id, index) => {
        this.#db
          .update(installJobs)
          .set({ position: index + 1, updatedAt: this.#now() })
          .where(eq(installJobs.id, id))
          .run();
      });
    });
    return this.listJobs(deviceId);
  }

  listJobs(deviceId?: number): WebJob[] {
    const rows = deviceId
      ? this.#db.select().from(installJobs).where(eq(installJobs.deviceId, deviceId)).all()
      : this.#db.select().from(installJobs).all();
    return rows
      .sort((a, b) => a.position - b.position || a.id - b.id)
      .map((row) => this.toWebJob(row));
  }

  async pollEvents(
    device: DeviceRow,
    query: { cursor?: string; wait?: number },
    signal?: AbortSignal,
  ): Promise<EventsResponse> {
    const waitMs = (query.wait ?? 25) * 1000;
    if (query.cursor === undefined) {
      const queued = this.listJobs(device.id).filter((job) => job.status === "queued");
      return {
        cursor: String(this.log.head()),
        ev: [
          ...queued.map((job) => ({ t: "job.queued" as const, job: this.toDeviceJob(job) })),
          { t: "catalog", rev: this.#catalogRev() },
        ],
      };
    }
    const cursor = Number(query.cursor);
    if (!Number.isInteger(cursor) || cursor < 0) {
      throw new ApiError("BAD_REQUEST", "cursor must be a non-negative integer");
    }
    const head = this.log.head();
    const oldest = this.log.since(device.id, -1)[0];
    if (cursor > head || (oldest !== undefined && cursor < oldest.id - 1 && cursor !== 0)) {
      return { cursor: String(head), ev: [{ t: "catalog", rev: this.#catalogRev() }] };
    }
    this.addWaiter(device.id);
    try {
      return await this.log.wait(device.id, cursor, waitMs, signal);
    } finally {
      this.removeWaiter(device.id);
    }
  }

  addWaiter(deviceId: number): void {
    const count = this.#waiters.get(deviceId) ?? 0;
    this.#waiters.set(deviceId, count + 1);
    if (count === 0) this.#events.publish({ type: "device.online", deviceId });
  }

  removeWaiter(deviceId: number): void {
    const count = this.#waiters.get(deviceId) ?? 0;
    if (count <= 1) {
      this.#waiters.delete(deviceId);
      this.#events.publish({ type: "device.offline", deviceId });
    } else {
      this.#waiters.set(deviceId, count - 1);
    }
  }

  isOnline(row: DeviceRow): boolean {
    if (row.revokedAt !== null) return false;
    if ((this.#waiters.get(row.id) ?? 0) > 0) return true;
    return row.lastSeen !== null && this.#now() - row.lastSeen < ONLINE_AFTER_MS;
  }

  purgeExpiredPairingCodes(): void {
    this.#db.delete(pairingCodes).where(lt(pairingCodes.expiresAt, this.#now())).run();
  }

  close(): void {
    for (const timer of this.#pendingJobEvent.values()) clearTimeout(timer);
    this.#pendingJobEvent.clear();
  }

  toSummary(row: DeviceRow) {
    const jobs = this.#db
      .select({ status: installJobs.status })
      .from(installJobs)
      .where(eq(installJobs.deviceId, row.id))
      .all();
    return {
      id: row.id,
      uuid: row.uuid,
      name: row.name,
      fw: row.fw,
      ams: row.ams,
      appVersion: row.appVersion,
      lastSeen: row.lastSeen,
      transport: row.transport,
      online: this.isOnline(row),
      revoked: row.revokedAt !== null,
      space: {
        sd:
          row.sdFree !== null && row.sdTotal !== null
            ? ([row.sdFree, row.sdTotal] as [number, number])
            : null,
        nand:
          row.nandFree !== null && row.nandTotal !== null
            ? ([row.nandFree, row.nandTotal] as [number, number])
            : null,
      },
      queuedJobs: jobs.filter((j) => j.status === "queued").length,
      runningJobs: jobs.filter((j) => j.status === "claimed" || j.status === "running").length,
    };
  }

  toWebJob(row: JobRow): WebJob {
    return {
      id: row.id,
      deviceId: row.deviceId,
      contentMetaId: row.contentMetaId,
      fileId: row.fileId,
      titleId: row.titleId,
      version: row.version,
      type: row.type,
      name: row.name,
      size: row.size,
      format: row.format,
      target: row.target,
      status: row.status,
      position: row.position,
      phase: row.phase,
      item: row.item,
      bytesDone: row.bytesDone,
      bps: row.bps,
      error: row.error,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      completedAt: row.completedAt,
    };
  }

  toDeviceJob(job: WebJob): Job {
    return {
      id: job.id,
      contentMetaId: job.contentMetaId,
      fileId: job.fileId,
      titleId: job.titleId,
      version: job.version,
      type: job.type,
      name: job.name,
      size: job.size,
      format: job.format,
      target: job.target,
      status: job.status,
    };
  }

  #loadOrCreateServerId(): string {
    const existing = setting(this.#db, SERVER_ID_KEY);
    if (existing) return existing;
    const id = randomUUID();
    putSetting(this.#db, SERVER_ID_KEY, id);
    return id;
  }

  #requireDeviceRow(id: number): DeviceRow {
    const row = this.#db.select().from(devices).where(eq(devices.id, id)).get();
    if (!row) throw new ApiError("NOT_FOUND", "That Switch is not in the library");
    return row;
  }

  #requireActiveDevice(id: number): DeviceRow {
    const row = this.#requireDeviceRow(id);
    if (row.revokedAt !== null) throw new ApiError("DEVICE_REVOKED", "That Switch was revoked");
    return row;
  }

  #requireJob(id: number): JobRow {
    const row = this.#db.select().from(installJobs).where(eq(installJobs.id, id)).get();
    if (!row) throw new ApiError("JOB_NOT_FOUND", "That install job no longer exists");
    return row;
  }

  #jobForDevice(deviceId: number, jobId: number): JobRow {
    const row = this.#requireJob(jobId);
    if (row.deviceId !== deviceId) {
      throw new ApiError("FORBIDDEN", "That job belongs to a different Switch");
    }
    return row;
  }

  #nextPosition(deviceId: number): number {
    const rows = this.#db
      .select({ position: installJobs.position })
      .from(installJobs)
      .where(
        and(
          eq(installJobs.deviceId, deviceId),
          inArray(installJobs.status, ["queued", "claimed", "running"]),
        ),
      )
      .all();
    return rows.reduce((max, row) => Math.max(max, row.position), 0) + 1;
  }

  #insertJob(
    deviceId: number,
    contentMetaId: number,
    target: InstallTarget,
    position: number,
  ): WebJob {
    const meta = this.#db
      .select()
      .from(contentMetas)
      .where(eq(contentMetas.id, contentMetaId))
      .get();
    if (!meta) throw new ApiError("NOT_FOUND", "That title is no longer in the library");
    const file = this.#db.select().from(files).where(eq(files.id, meta.fileId)).get();
    const root = file
      ? this.#db.select().from(libraryRoots).where(eq(libraryRoots.id, file.rootId)).get()
      : undefined;
    if (!file || file.missingSince !== null || !root?.enabled) {
      throw new ApiError("FILE_MISSING", "The file for that title is no longer in the library");
    }
    const now = this.#now();
    const inserted = this.#db
      .insert(installJobs)
      .values({
        deviceId,
        contentMetaId,
        fileId: file.id,
        titleId: meta.titleId,
        version: meta.version ?? 0,
        type: meta.type,
        name: meta.displayName,
        size: file.size,
        format: file.format,
        target,
        position,
        status: "queued",
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return this.toWebJob(inserted);
  }

  #interruptActiveJobs(deviceId: number, message: string): void {
    const now = this.#now();
    const active = this.#db
      .select()
      .from(installJobs)
      .where(
        and(
          eq(installJobs.deviceId, deviceId),
          inArray(installJobs.status, ["queued", "claimed", "running"]),
        ),
      )
      .all();
    for (const row of active) {
      const status = row.status === "queued" ? "cancelled" : "interrupted";
      const updated = this.#db
        .update(installJobs)
        .set({ status, error: message, updatedAt: now, completedAt: now })
        .where(eq(installJobs.id, row.id))
        .returning()
        .get();
      if (row.status !== "queued") this.log.append(deviceId, { t: "job.cancel", id: row.id });
      this.#publishJob(this.toWebJob(updated));
    }
  }

  #publishJob(job: WebJob, throttle = false): void {
    const publish = () => {
      this.#pendingJobEvent.delete(job.id);
      this.#lastJobEventAt.set(job.id, this.#now());
      this.#events.publish({ type: "job.updated", job });
    };
    if (!throttle) {
      const pending = this.#pendingJobEvent.get(job.id);
      if (pending) clearTimeout(pending);
      publish();
      return;
    }
    const elapsed = this.#now() - (this.#lastJobEventAt.get(job.id) ?? 0);
    if (elapsed >= JOB_EVENT_MIN_INTERVAL_MS) {
      publish();
      return;
    }
    if (this.#pendingJobEvent.has(job.id)) return;
    const timer = setTimeout(publish, JOB_EVENT_MIN_INTERVAL_MS - elapsed);
    timer.unref();
    this.#pendingJobEvent.set(job.id, timer);
  }
}
