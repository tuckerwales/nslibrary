/** Web UI API (`/api/v1`) request schemas and response types. */
import { z } from "zod";
import {
  type ContainerFormat,
  type InstallPhase,
  type InstallTarget,
  InstallTargetSchema,
  type JobStatus,
  type SaveOrigin,
  type SaveType,
} from "./device-api";
import type { ContentMetaType } from "./title-id";

export const SetupRequestSchema = z.object({
  username: z.string().trim().min(1, "Enter a username").max(64),
  password: z.string().min(8, "Use at least 8 characters").max(256),
  /** Required when the server sets NSLIB_SETUP_TOKEN. */
  setupToken: z.string().max(256).optional(),
});

export const LoginRequestSchema = z.object({
  username: z.string().trim().min(1, "Enter your username").max(64),
  password: z.string().min(1, "Enter your password").max(256),
});

export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password").max(256),
  newPassword: z.string().min(8, "Use at least 8 characters").max(256),
});

export const CreateRootRequestSchema = z.object({
  path: z.string().trim().min(1, "Enter a folder path").max(4096),
  label: z.string().trim().max(128).optional(),
  usePolling: z.boolean().optional(),
});

export const UpdateRootRequestSchema = z.object({
  label: z.string().trim().max(128).nullable().optional(),
  enabled: z.boolean().optional(),
  usePolling: z.boolean().optional(),
});

export const PutKeysRequestSchema = z.object({
  contents: z
    .string()
    .min(1, "Paste the contents of prod.keys")
    .max(512_000, "That file is too large to be prod.keys"),
});

export const TitledbConfigSchema = z.object({
  enabled: z.boolean().optional(),
  source: z.string().trim().max(4096).nullable().optional(),
});

export const VerifyRequestSchema = z.object({
  mode: z.enum(["quick", "full"]).optional(),
});

/** zstd levels. 18 is nsz's default; 22 is the slowest and smallest. */
export const COMPRESS_LEVEL_MIN = 1;
export const COMPRESS_LEVEL_MAX = 22;
export const DEFAULT_COMPRESS_LEVEL = 18;

export const CompressSettingsSchema = z.object({
  /** Absolute folder on the server that new NSZ files are written to. Null clears it. */
  outputDir: z.string().trim().max(4096).nullable().optional(),
  level: z.number().int().min(COMPRESS_LEVEL_MIN).max(COMPRESS_LEVEL_MAX).optional(),
  /** Delete the NSP once its NSZ has been written and checked. */
  removeOriginal: z.boolean().optional(),
  /** Create `outputDir` (one level, inside an existing folder) if it doesn't exist yet. */
  createOutputDir: z.boolean().optional(),
});

export const CompressRequestSchema = z.object({
  fileIds: z.array(z.number().int().positive()).min(1, "Choose at least one file").max(10_000),
});

export const RenameDeviceRequestSchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(64),
});

export const CreateJobsRequestSchema = z.object({
  deviceId: z.number().int().positive(),
  items: z.array(z.number().int().positive()).min(1),
  target: InstallTargetSchema.optional(),
});

export const ReorderJobsRequestSchema = z.object({
  deviceId: z.number().int().positive(),
  ids: z.array(z.number().int().positive()),
});

export const ServerSettingsSchema = z.object({
  preferNsz: z.boolean().optional(),
  serverName: z.string().trim().min(1).max(64).optional(),
  requireUsbPairing: z.boolean().optional(),
  saveBackupsKeep: z.number().int().min(0).max(1000).optional(),
});

export const UpdateSaveBackupRequestSchema = z.object({
  pinned: z.boolean().optional(),
  note: z.string().trim().max(200).nullable().optional(),
});

export const SaveBackupQuerySchema = z.object({
  app: z
    .string()
    .regex(/^[0-9A-Fa-f]{16}$/, "Expected a 16-digit title ID")
    .transform((id) => id.toUpperCase())
    .optional(),
});

export type SetupRequest = z.infer<typeof SetupRequestSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;
export type CreateRootRequest = z.infer<typeof CreateRootRequestSchema>;
export type UpdateRootRequest = z.infer<typeof UpdateRootRequestSchema>;
export type PutKeysRequest = z.infer<typeof PutKeysRequestSchema>;
export type TitledbConfig = z.infer<typeof TitledbConfigSchema>;
export type VerifyRequest = z.infer<typeof VerifyRequestSchema>;
export type CompressSettingsPatch = z.infer<typeof CompressSettingsSchema>;
export type CompressRequest = z.infer<typeof CompressRequestSchema>;
export type RenameDeviceRequest = z.infer<typeof RenameDeviceRequestSchema>;
export type CreateJobsRequest = z.infer<typeof CreateJobsRequestSchema>;
export type ReorderJobsRequest = z.infer<typeof ReorderJobsRequestSchema>;
export type ServerSettingsPatch = z.infer<typeof ServerSettingsSchema>;
export type UpdateSaveBackupRequest = z.infer<typeof UpdateSaveBackupRequestSchema>;
export type SaveBackupQuery = z.infer<typeof SaveBackupQuerySchema>;

export interface KeyStatus {
  configured: boolean;
  names: string[];
  headerKey: boolean;
  keyAreaKeyGenerations: number[];
  titlekekGenerations: number[];
  /** True when the loaded keys are the synthetic demo set, not keys from a console. */
  demo: boolean;
}

export interface TitledbStatus {
  enabled: boolean;
  source: string | null;
  titleCount: number;
  lastRefreshAt: number | null;
  lastError: string | null;
}

export interface VerifyItem {
  ncaId: string;
  ok: boolean;
  message: string;
}

export interface VerifyResult {
  status: VerifyStatus;
  mode: VerifyMode;
  items: VerifyItem[];
}

export type VerifyTaskState = "queued" | "running" | "done" | "failed" | "cancelled";

/** A verify running in the background. Updates arrive as `verify.updated` events. */
export interface VerifyTask {
  fileId: number;
  mode: VerifyMode;
  state: VerifyTaskState;
  /** NCA bytes hashed so far, out of the total of the file's content records. */
  bytesDone: number;
  bytesTotal: number;
  /** Set when `state` is `done`. */
  result: VerifyResult | null;
  /** Set when `state` is `failed`. */
  error: string | null;
  startedAt: number;
  updatedAt: number;
}

export interface CompressSettings {
  outputDir: string | null;
  level: number;
  removeOriginal: boolean;
  /** prod.keys with a header key are loaded; compressing needs them. */
  keysReady: boolean;
  /** Whether `outputDir` is inside an enabled library folder, so new files show up by themselves. */
  outputInLibrary: boolean;
  /** Why compressing can't start right now (no folder, folder gone or read-only, no keys). */
  problem: string | null;
}

export type CompressPhase = "compressing" | "checking" | "finishing";

/** One entry of the NSP and what became of it. */
export interface CompressItem {
  name: string;
  /** `name` with `.nca` changed to `.ncz` when it was compressed. */
  outputName: string;
  compressed: boolean;
  sourceSize: number;
  outputSize: number;
  /** Why an NCA that is normally compressed was copied as it is. */
  note: string | null;
}

export interface CompressResult {
  /** Absolute path of the new NSZ on the server. */
  outputPath: string;
  sourceSize: number;
  outputSize: number;
  /** `sourceSize - outputSize`. */
  savedBytes: number;
  items: CompressItem[];
  /** The output folder is in the library, so the NSZ is (or soon will be) listed. */
  inLibrary: boolean;
  originalRemoved: boolean;
  warnings: string[];
}

/** A compression running in the background. Updates arrive as `compress.updated` events. */
export interface CompressTask {
  fileId: number;
  /** The source file, relative to its library folder. */
  relPath: string;
  /** The title's name, for people rather than file systems. */
  name: string;
  state: VerifyTaskState;
  phase: CompressPhase | null;
  /** When the current phase began, so clients can estimate the time left. */
  phaseStartedAt: number | null;
  /** Progress through the current phase: bytes read from the NSP, then from the NSZ. */
  bytesDone: number;
  bytesTotal: number;
  /** Set when `state` is `done`. */
  result: CompressResult | null;
  /** Set when `state` is `failed`. */
  error: string | null;
  startedAt: number;
  updatedAt: number;
}

/** A folder the Compression page offers as the output folder. */
export interface CompressFolderOption {
  path: string;
  /** The library folder it is in (or is). */
  rootPath: string;
  /** Already on disk; otherwise saving it with `createOutputDir` makes it. */
  exists: boolean;
  /** The server can write there (or, when it doesn't exist, in its parent). */
  writable: boolean;
}

/** An NSP whose content isn't in the library as NSZ yet. */
export interface CompressCandidate {
  file: LibraryFileInfo;
  name: string;
  type: ContentMetaType;
  version: number | null;
}

export interface CompressStartResponse {
  tasks: CompressTask[];
  /** Files that weren't queued, with the reason. */
  skipped: { fileId: number; reason: string }[];
}

export interface AuthStatus {
  setupRequired: boolean;
  /** True while setup is required and the server asks for its setup token. */
  setupTokenRequired: boolean;
  authenticated: boolean;
  username: string | null;
}

export type ParseStatus = "pending" | "ok" | "unidentified" | "error";
export type MetadataSource = "filename" | "ticket" | "cnmt" | "nacp";
/** How an item's application was determined: read directly, derived from its title ID, or guessed. */
/** `titledb`: a guessed DLC base replaced by the base game ID the title database lists. */
export type ApplicationIdSource = "exact" | "derived" | "guess" | "titledb";
export type ScanState = "idle" | "walking" | "parsing";

export interface ScanProgress {
  state: ScanState;
  done: number;
  total: number;
}

export interface LibraryRoot {
  id: number;
  path: string;
  label: string | null;
  enabled: boolean;
  usePolling: boolean;
  lastScanAt: number | null;
  lastScanError: string | null;
  fileCount: number;
  totalSize: number;
  missingCount: number;
  scan: ScanProgress;
}

export type AppFlag =
  /** Updates or DLC are present but the base game is not. */
  | "no-base"
  /** The same title and version exists in more than one file. */
  | "duplicate"
  /** More than one update version is present. */
  | "superseded-updates"
  /** A DLC's base game was guessed from its title ID. */
  | "guessed-dlc-base"
  /** An update's version could not be read. */
  | "unknown-version"
  /** Titledb lists a newer update than any file in the library. */
  | "update-available";

/** Library orderings for `GET /apps`. Ties fall back to name, then application ID. */
export const APP_SORTS = ["name", "added"] as const;
export type AppSort = (typeof APP_SORTS)[number];
export type SortOrder = "asc" | "desc";

export interface AppSummary {
  applicationId: string;
  name: string;
  publisher: string | null;
  iconUrl: string | null;
  hasBase: boolean;
  baseFormats: ContainerFormat[];
  /** Distinct known update versions, newest first. */
  updateVersions: number[];
  addonCount: number;
  fileCount: number;
  totalSize: number;
  /** When the game's earliest present file was first seen, in epoch milliseconds. */
  addedAt: number;
  flags: AppFlag[];
}

export type VerifyStatus = "unverified" | "ok" | "bad" | "partial";
export type VerifyMode = "quick" | "full";

export interface LibraryFileInfo {
  id: number;
  rootId: number;
  relPath: string;
  format: ContainerFormat;
  size: number;
  parseStatus: ParseStatus;
  parseError: string | null;
  metadataSource: MetadataSource | null;
  verifyStatus: VerifyStatus;
  missingSince: number | null;
}

export interface AppContent {
  /** Content-meta row of the preferred file (NSZ over NSP by default). Used to queue installs. */
  contentMetaId: number;
  titleId: string;
  type: ContentMetaType;
  version: number | null;
  name: string;
  applicationIdSource: ApplicationIdSource;
  keyGeneration: number | null;
  requiredSystemVersion: number | null;
  installSize: number | null;
  files: LibraryFileInfo[];
}

export interface AppDetail extends AppSummary {
  contents: AppContent[];
}

export interface HomebrewItem {
  fileId: number;
  name: string;
  publisher: string | null;
  version: string | null;
  relPath: string;
  size: number;
  iconUrl: string | null;
}

export interface DuplicateGroup {
  titleId: string;
  version: number | null;
  name: string;
  applicationId: string;
  files: LibraryFileInfo[];
}

export interface ProblemsReport {
  unreadable: LibraryFileInfo[];
  unidentified: LibraryFileInfo[];
  missing: LibraryFileInfo[];
  duplicates: DuplicateGroup[];
}

export interface LibraryStats {
  applications: number;
  files: number;
  totalSize: number;
  homebrew: number;
  problems: number;
  keysConfigured: boolean;
  catalogRev: number;
}

export interface PairingCode {
  code: string;
  expiresAt: number;
}

export interface DeviceSpace {
  sd: [number, number] | null;
  nand: [number, number] | null;
}

export interface InstalledTitle {
  titleId: string;
  version: number;
  type: ContentMetaType;
  storage: "sd" | "nand";
  applicationId: string;
}

export interface DeviceSummary {
  id: number;
  uuid: string;
  name: string;
  fw: string | null;
  ams: string | null;
  appVersion: string | null;
  lastSeen: number | null;
  transport: "http" | "usb" | null;
  online: boolean;
  revoked: boolean;
  space: DeviceSpace;
  queuedJobs: number;
  runningJobs: number;
}

export interface DeviceDetail extends DeviceSummary {
  titles: InstalledTitle[];
}

export type JobSource = "web" | "switch";

export interface WebJob {
  id: number;
  deviceId: number;
  contentMetaId: number;
  fileId: number;
  titleId: string;
  version: number;
  type: ContentMetaType;
  name: string;
  size: number;
  format: ContainerFormat;
  target: InstallTarget;
  source: JobSource;
  status: JobStatus;
  position: number;
  phase: InstallPhase | null;
  item: string | null;
  bytesDone: number;
  bps: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface ServerSettings {
  preferNsz: boolean;
  serverName: string;
  requireUsbPairing: boolean;
  /**
   * Backups kept for each save, newest first. Pinned backups are kept on top of these and never
   * removed automatically. 0 keeps everything.
   */
  saveBackupsKeep: number;
}

/** A save data backup made by a Switch, stored on the server. */
export interface SaveBackup {
  id: number;
  applicationId: string;
  /** The library's name for the game, else the name the console sent, else the ID. */
  name: string;
  iconUrl: string | null;
  /** Whether the game is in the library, so its page exists. */
  inLibrary: boolean;
  type: SaveType;
  /** Account UID on the console the backup came from. Null for device saves. */
  userId: string | null;
  userName: string | null;
  /** Null once that console has been removed. */
  deviceId: number | null;
  deviceName: string;
  /** Archive size in bytes. */
  size: number;
  /** Sum of the file sizes inside the archive. */
  dataSize: number;
  fileCount: number;
  sha256: string;
  origin: SaveOrigin;
  pinned: boolean;
  note: string | null;
  createdAt: number;
}

export interface ForwarderStatus {
  keys: boolean;
  loader: "real" | "stub";
  titleId: string;
  name: string;
}

export const CreateForwarderRequestSchema = z.object({
  titleId: z
    .string()
    .regex(/^[0-9A-Fa-f]{16}$/)
    .optional(),
  name: z.string().trim().min(1).max(64).optional(),
  publisher: z.string().trim().min(1).max(64).optional(),
});
export type CreateForwarderRequest = z.infer<typeof CreateForwarderRequestSchema>;

export type ServerEvent =
  | { type: "scan.progress"; rootId: number; scan: ScanProgress }
  | { type: "library.changed"; rev: number }
  | { type: "roots.changed" }
  | { type: "device.paired"; deviceId: number; name: string }
  | { type: "device.online"; deviceId: number }
  | { type: "device.offline"; deviceId: number }
  | { type: "job.updated"; job: WebJob }
  | { type: "verify.updated"; task: VerifyTask }
  | { type: "saves.changed" }
  | { type: "compress.updated"; task: CompressTask };
