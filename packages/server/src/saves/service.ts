import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { FormatError, readSaveArchive } from "@nslib/formats";
import type {
  DeviceSaveBackup,
  SaveBackup,
  SaveUploadQuery,
  UpdateSaveBackupRequest,
} from "@nslib/shared";
import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
import { ApiError } from "../api/errors";
import type { Db } from "../db/client";
import { type DeviceRow, devices, type SaveBackupRow, saveBackups } from "../db/schema";
import type { EventBus } from "../events";
import { FileHandleReader } from "../library/file-reader";

/** Largest archive accepted by default. Real saves are rarely more than a few tens of MB. */
export const DEFAULT_SAVE_MAX_BYTES = 1024 * 1024 * 1024;

export interface SaveServiceOptions {
  db: Db;
  events: EventBus;
  dataDir: string;
  now?: () => number;
  /** Backups kept per save; 0 keeps everything. Read on every upload, so settings apply at once. */
  keep: () => number;
  maxBytes?: number;
}

/** What identifies one save: a game's account save for one user on one console, or its device save. */
interface SaveKey {
  applicationId: string;
  saveType: SaveBackupRow["saveType"];
  userId: string | null;
  deviceId: number | null;
}

export interface StoredSave {
  row: SaveBackupRow;
  /** True when the newest backup of this save already had these bytes, so nothing was stored. */
  dup: boolean;
}

/** Names and icons for games, from the library. Missing games fall back to what the console sent. */
export type AppNames = (
  applicationIds: string[],
) => Map<string, { name: string; iconUrl: string | null; inLibrary: boolean }>;

function keyOf(row: SaveBackupRow): SaveKey {
  return {
    applicationId: row.applicationId,
    saveType: row.saveType,
    userId: row.userId,
    deviceId: row.deviceId,
  };
}

function sameSave(key: SaveKey): SQL | undefined {
  return and(
    eq(saveBackups.applicationId, key.applicationId),
    eq(saveBackups.saveType, key.saveType),
    key.userId === null ? isNull(saveBackups.userId) : eq(saveBackups.userId, key.userId),
    key.deviceId === null ? isNull(saveBackups.deviceId) : eq(saveBackups.deviceId, key.deviceId),
  );
}

function saveKeyString(row: SaveBackupRow): string {
  return [row.applicationId, row.saveType, row.userId ?? "", row.deviceId ?? ""].join(":");
}

/** Counts and hashes bytes on their way to disk, and stops once there are too many. */
class Meter extends Transform {
  readonly hash = createHash("sha256");
  bytes = 0;

  constructor(private readonly max: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: (err?: Error) => void) {
    this.bytes += chunk.length;
    if (this.bytes > this.max) {
      done(new ApiError("PAYLOAD_TOO_LARGE", tooLargeMessage(this.max)));
      return;
    }
    this.hash.update(chunk);
    this.push(chunk);
    done();
  }
}

function tooLargeMessage(max: number): string {
  const limit =
    max >= 1024 * 1024 ? `${Math.floor(max / (1024 * 1024))} MB` : `${Math.ceil(max / 1024)} KB`;
  return `Save archives larger than ${limit} are not accepted (NSLIB_SAVE_MAX_MB)`;
}

/**
 * Stores save data archives uploaded by paired consoles. Archives live under `<dataDir>/saves`,
 * never in a library folder, and are validated as plain file trees before they are kept.
 */
export class SaveService {
  readonly dir: string;
  readonly maxBytes: number;
  readonly #tmpDir: string;
  readonly #db: Db;
  readonly #events: EventBus;
  readonly #now: () => number;
  readonly #keep: () => number;

  constructor(options: SaveServiceOptions) {
    this.#db = options.db;
    this.#events = options.events;
    this.#now = options.now ?? Date.now;
    this.#keep = options.keep;
    this.maxBytes = options.maxBytes ?? DEFAULT_SAVE_MAX_BYTES;
    this.dir = join(options.dataDir, "saves");
    this.#tmpDir = join(this.dir, ".incoming");
  }

  /** Creates the folders and clears uploads a previous run left half-written. */
  async init(): Promise<void> {
    await mkdir(this.#tmpDir, { recursive: true });
    for (const name of await readdir(this.#tmpDir)) {
      await rm(join(this.#tmpDir, name), { force: true });
    }
  }

  archivePath(row: Pick<SaveBackupRow, "applicationId" | "id">): string {
    return join(this.dir, row.applicationId, `${row.id}.tar`);
  }

  /**
   * Streams an upload to disk, checks its SHA-256 and that it is a valid save archive, then keeps
   * it unless the newest backup of the same save is byte-identical.
   */
  async store(
    body: Readable | AsyncIterable<Uint8Array> | Uint8Array,
    query: SaveUploadQuery,
    device: DeviceRow,
    declaredLength?: number,
  ): Promise<StoredSave> {
    if (declaredLength !== undefined && declaredLength > this.maxBytes) {
      throw new ApiError("PAYLOAD_TOO_LARGE", tooLargeMessage(this.maxBytes));
    }
    await mkdir(this.#tmpDir, { recursive: true });
    const tmp = join(this.#tmpDir, `${randomUUID()}.tar`);
    try {
      const meter = new Meter(this.maxBytes);
      const source = body instanceof Uint8Array ? Readable.from([body]) : Readable.from(body);
      await pipeline(source, meter, createWriteStream(tmp));
      const sha256 = meter.hash.digest("hex");
      if (sha256 !== query.sha256) {
        throw new ApiError(
          "SAVE_INVALID",
          "The save archive arrived damaged (its SHA-256 does not match). Try again.",
        );
      }
      const listing = await this.#validate(tmp);

      const key: SaveKey = {
        applicationId: query.app,
        saveType: query.type,
        userId: query.user ?? null,
        deviceId: device.id,
      };
      const latest = this.#db
        .select()
        .from(saveBackups)
        .where(sameSave(key))
        .orderBy(desc(saveBackups.createdAt), desc(saveBackups.id))
        .limit(1)
        .get();
      if (latest && latest.sha256 === sha256) {
        await rm(tmp, { force: true });
        return { row: latest, dup: true };
      }

      const row = this.#db
        .insert(saveBackups)
        .values({
          applicationId: query.app,
          appName: query.name?.trim() || null,
          saveType: query.type,
          userId: query.user ?? null,
          userName: query.userName?.trim() || null,
          deviceId: device.id,
          deviceName: device.name,
          origin: query.origin,
          size: meter.bytes,
          dataSize: listing.dataSize,
          fileCount: listing.fileCount,
          sha256,
          createdAt: this.#now(),
        })
        .returning()
        .get();
      try {
        await mkdir(join(this.dir, row.applicationId), { recursive: true });
        await rename(tmp, this.archivePath(row));
      } catch (err) {
        this.#db.delete(saveBackups).where(eq(saveBackups.id, row.id)).run();
        throw err;
      }
      await this.#prune(keyOf(row));
      this.#events.publish({ type: "saves.changed" });
      return { row, dup: false };
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async #validate(path: string) {
    const reader = await FileHandleReader.open(path);
    try {
      return await readSaveArchive(reader);
    } catch (err) {
      if (err instanceof FormatError) {
        throw new ApiError("SAVE_INVALID", `Not a usable save archive: ${err.message}`);
      }
      throw err;
    } finally {
      await reader.close();
    }
  }

  /** Newest first. `latest` keeps only the newest backup of each save. */
  list(options: { applicationId?: string; latest?: boolean } = {}): SaveBackupRow[] {
    const rows = this.#db
      .select()
      .from(saveBackups)
      .where(
        options.applicationId ? eq(saveBackups.applicationId, options.applicationId) : undefined,
      )
      .orderBy(desc(saveBackups.createdAt), desc(saveBackups.id))
      .all();
    if (!options.latest) return rows;
    const seen = new Set<string>();
    return rows.filter((row) => {
      const key = saveKeyString(row);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  get(id: number): SaveBackupRow {
    const row = this.#db.select().from(saveBackups).where(eq(saveBackups.id, id)).get();
    if (!row) throw new ApiError("NOT_FOUND", "That save backup no longer exists");
    return row;
  }

  /** The archive on disk, or FILE_MISSING when someone removed it from the data folder. */
  async locate(id: number): Promise<{ row: SaveBackupRow; path: string; size: number }> {
    const row = this.get(id);
    const path = this.archivePath(row);
    try {
      const info = await stat(path);
      return { row, path, size: info.size };
    } catch {
      throw new ApiError(
        "FILE_MISSING",
        "The archive for that save backup is missing on the server",
      );
    }
  }

  update(id: number, patch: UpdateSaveBackupRequest): SaveBackupRow {
    this.get(id);
    const set: Partial<SaveBackupRow> = {};
    if (patch.pinned !== undefined) set.pinned = patch.pinned;
    if (patch.note !== undefined) set.note = patch.note?.trim() || null;
    if (Object.keys(set).length > 0) {
      this.#db.update(saveBackups).set(set).where(eq(saveBackups.id, id)).run();
    }
    // Unpinning never deletes on the spot: the backup is only pruned with the next one of its save.
    this.#events.publish({ type: "saves.changed" });
    return this.get(id);
  }

  async delete(id: number): Promise<void> {
    const row = this.get(id);
    await this.#remove([row]);
    this.#events.publish({ type: "saves.changed" });
  }

  /** Applies the retention setting to every save, e.g. after it was lowered. */
  async pruneAll(): Promise<number> {
    const saves = new Map<string, SaveKey>();
    for (const row of this.list({ latest: true })) saves.set(saveKeyString(row), keyOf(row));
    let removed = 0;
    for (const key of saves.values()) removed += await this.#prune(key);
    if (removed > 0) this.#events.publish({ type: "saves.changed" });
    return removed;
  }

  async #prune(key: SaveKey): Promise<number> {
    const keep = this.#keep();
    if (keep <= 0) return 0;
    const unpinned = this.#db
      .select()
      .from(saveBackups)
      .where(and(sameSave(key), eq(saveBackups.pinned, false)))
      .orderBy(desc(saveBackups.createdAt), desc(saveBackups.id))
      .all();
    const excess = unpinned.slice(keep);
    await this.#remove(excess);
    return excess.length;
  }

  async #remove(rows: SaveBackupRow[]): Promise<void> {
    for (const row of rows) {
      this.#db.delete(saveBackups).where(eq(saveBackups.id, row.id)).run();
      await rm(this.archivePath(row), { force: true });
    }
  }

  /** Current device names, so a renamed console shows its new name. */
  #deviceNames(): Map<number, string> {
    return new Map(
      this.#db
        .select({ id: devices.id, name: devices.name })
        .from(devices)
        .all()
        .map((d) => [d.id, d.name]),
    );
  }

  toDevice(rows: SaveBackupRow[], deviceId: number): DeviceSaveBackup[] {
    const names = this.#deviceNames();
    return rows.map((row) => ({
      id: row.id,
      app: row.applicationId,
      type: row.saveType,
      user: row.userId,
      userName: row.userName,
      device: (row.deviceId !== null ? names.get(row.deviceId) : undefined) ?? row.deviceName,
      mine: row.deviceId === deviceId,
      size: row.size,
      dataSize: row.dataSize,
      files: row.fileCount,
      sha256: row.sha256,
      at: Math.floor(row.createdAt / 1000),
      origin: row.origin,
      pinned: row.pinned,
      note: row.note,
    }));
  }

  toWeb(rows: SaveBackupRow[], appNames: AppNames): SaveBackup[] {
    const names = this.#deviceNames();
    const apps = appNames([...new Set(rows.map((row) => row.applicationId))]);
    return rows.map((row) => {
      const app = apps.get(row.applicationId);
      return {
        id: row.id,
        applicationId: row.applicationId,
        name: app?.name ?? row.appName ?? row.applicationId,
        iconUrl: app?.iconUrl ?? null,
        inLibrary: app?.inLibrary ?? false,
        type: row.saveType,
        userId: row.userId,
        userName: row.userName,
        deviceId: row.deviceId,
        deviceName: (row.deviceId !== null ? names.get(row.deviceId) : undefined) ?? row.deviceName,
        size: row.size,
        dataSize: row.dataSize,
        fileCount: row.fileCount,
        sha256: row.sha256,
        origin: row.origin,
        pinned: row.pinned,
        note: row.note,
        createdAt: row.createdAt,
      };
    });
  }
}
