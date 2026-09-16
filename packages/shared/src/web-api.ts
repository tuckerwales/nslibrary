/** Web UI API (`/api/v1`) request schemas and response types. */
import { z } from "zod";
import type { ContainerFormat } from "./device-api";
import type { ContentMetaType } from "./title-id";

export const SetupRequestSchema = z.object({
  username: z.string().trim().min(1, "Enter a username").max(64),
  password: z.string().min(8, "Use at least 8 characters").max(256),
});

export const LoginRequestSchema = z.object({
  username: z.string().trim().min(1, "Enter your username").max(64),
  password: z.string().min(1, "Enter your password").max(256),
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

export type SetupRequest = z.infer<typeof SetupRequestSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type CreateRootRequest = z.infer<typeof CreateRootRequestSchema>;
export type UpdateRootRequest = z.infer<typeof UpdateRootRequestSchema>;
export type PutKeysRequest = z.infer<typeof PutKeysRequestSchema>;
export type TitledbConfig = z.infer<typeof TitledbConfigSchema>;
export type VerifyRequest = z.infer<typeof VerifyRequestSchema>;

export interface KeyStatus {
  configured: boolean;
  names: string[];
  headerKey: boolean;
  keyAreaKeyGenerations: number[];
  titlekekGenerations: number[];
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

export interface AuthStatus {
  setupRequired: boolean;
  authenticated: boolean;
  username: string | null;
}

export type ParseStatus = "pending" | "ok" | "unidentified" | "error";
export type MetadataSource = "filename" | "ticket" | "cnmt" | "nacp";
/** How an item's application was determined: read directly, derived from its title ID, or guessed. */
export type ApplicationIdSource = "exact" | "derived" | "guess";
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

export type ServerEvent =
  | { type: "scan.progress"; rootId: number; scan: ScanProgress }
  | { type: "library.changed"; rev: number }
  | { type: "roots.changed" };
