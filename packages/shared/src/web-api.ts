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

export type SetupRequest = z.infer<typeof SetupRequestSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type CreateRootRequest = z.infer<typeof CreateRootRequestSchema>;
export type UpdateRootRequest = z.infer<typeof UpdateRootRequestSchema>;

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
  | "unknown-version";

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

export interface LibraryFileInfo {
  id: number;
  rootId: number;
  relPath: string;
  format: ContainerFormat;
  size: number;
  parseStatus: ParseStatus;
  parseError: string | null;
  metadataSource: MetadataSource | null;
  missingSince: number | null;
}

export interface AppContent {
  titleId: string;
  type: ContentMetaType;
  version: number | null;
  name: string;
  applicationIdSource: ApplicationIdSource;
  keyGeneration: number | null;
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
