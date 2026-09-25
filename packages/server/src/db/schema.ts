import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const FILE_FORMATS = ["nsp", "nsz", "xci", "xcz", "nro"] as const;
const PARSE_STATUSES = ["pending", "ok", "unidentified", "error"] as const;
const METADATA_SOURCES = ["filename", "ticket", "cnmt", "nacp"] as const;
const VERIFY_STATUSES = ["unverified", "ok", "bad", "partial"] as const;
const CONTENT_TYPES = ["application", "patch", "addon"] as const;
// "titledb" is only ever computed when reading (library/titledb-join.ts), never stored.
const APPLICATION_ID_SOURCES = ["exact", "derived", "guess", "titledb"] as const;
const ENTRY_KINDS = ["cnmt", "nca", "ncz", "tik", "cert", "other"] as const;
const TRANSPORTS = ["http", "usb"] as const;
const JOB_STATUSES = [
  "queued",
  "claimed",
  "running",
  "done",
  "failed",
  "cancelled",
  "interrupted",
] as const;
const INSTALL_TARGETS = ["sd", "nand", "auto"] as const;
const JOB_SOURCES = ["web", "switch"] as const;
const INSTALL_PHASES = ["preflight", "ticket", "meta", "content", "commit", "record"] as const;
const STORAGES = ["sd", "nand"] as const;
const SAVE_TYPES = ["account", "device"] as const;
const SAVE_ORIGINS = ["manual", "auto", "pre-restore"] as const;

/** Timestamps are epoch milliseconds. */
export const libraryRoots = sqliteTable("library_roots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  path: text("path").notNull().unique(),
  label: text("label"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  usePolling: integer("use_polling", { mode: "boolean" }).notNull().default(false),
  lastScanAt: integer("last_scan_at"),
  lastScanError: text("last_scan_error"),
  createdAt: integer("created_at").notNull(),
});

export const files = sqliteTable(
  "files",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    rootId: integer("root_id")
      .notNull()
      .references(() => libraryRoots.id, { onDelete: "cascade" }),
    /** Relative to the root, always with forward slashes. */
    relPath: text("rel_path").notNull(),
    format: text("format", { enum: FILE_FORMATS }).notNull(),
    size: integer("size").notNull(),
    mtimeMs: integer("mtime_ms").notNull(),
    parseStatus: text("parse_status", { enum: PARSE_STATUSES }).notNull().default("pending"),
    parseError: text("parse_error"),
    parserVersion: integer("parser_version").notNull().default(0),
    metadataSource: text("metadata_source", { enum: METADATA_SOURCES }),
    verifyStatus: text("verify_status", { enum: VERIFY_STATUSES }).notNull().default("unverified"),
    verifiedAt: integer("verified_at"),
    firstSeenAt: integer("first_seen_at").notNull(),
    /** Set when the file disappears; rows are kept (for history) and purged later. */
    missingSince: integer("missing_since"),
  },
  (t) => [
    uniqueIndex("files_root_path_idx").on(t.rootId, t.relPath),
    index("files_missing_idx").on(t.missingSince),
  ],
);

export const containerEntries = sqliteTable(
  "container_entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fileId: integer("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    offset: integer("entry_offset").notNull(),
    size: integer("size").notNull(),
    kind: text("kind", { enum: ENTRY_KINDS }).notNull(),
  },
  (t) => [index("container_entries_file_idx").on(t.fileId)],
);

export const contentMetas = sqliteTable(
  "content_metas",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fileId: integer("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    titleId: text("title_id").notNull(),
    /** Null when only a filename without a [vNNN] tag identified the content. */
    version: integer("version"),
    type: text("type", { enum: CONTENT_TYPES }).notNull(),
    applicationId: text("application_id").notNull(),
    applicationIdSource: text("application_id_source", { enum: APPLICATION_ID_SOURCES }).notNull(),
    displayName: text("display_name").notNull(),
    keyGeneration: integer("key_generation"),
    rightsId: text("rights_id"),
    requiredSystemVersion: integer("required_system_version"),
    installSize: integer("install_size"),
    source: text("source", { enum: METADATA_SOURCES }).notNull(),
  },
  (t) => [
    uniqueIndex("content_metas_file_title_idx").on(t.fileId, t.titleId),
    index("content_metas_application_idx").on(t.applicationId),
    index("content_metas_title_idx").on(t.titleId, t.version),
  ],
);

export const contentRecords = sqliteTable(
  "content_records",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    metaId: integer("meta_id")
      .notNull()
      .references(() => contentMetas.id, { onDelete: "cascade" }),
    ncaId: text("nca_id").notNull(),
    type: text("type").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    compressed: integer("compressed", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    index("content_records_meta_idx").on(t.metaId),
    uniqueIndex("content_records_meta_nca_idx").on(t.metaId, t.ncaId),
  ],
);

export const titledbTitles = sqliteTable("titledb_titles", {
  titleId: text("title_id").primaryKey(),
  name: text("name"),
  publisher: text("publisher"),
  description: text("description"),
  iconUrl: text("icon_url"),
  latestVersion: integer("latest_version"),
  applicationId: text("application_id"),
  updatedAt: integer("updated_at").notNull(),
});

/** Metadata better than filenames (NACP with keys, or titledb). */
export const applications = sqliteTable("applications", {
  applicationId: text("application_id").primaryKey(),
  name: text("name"),
  nameSource: text("name_source", { enum: ["nacp", "titledb"] }),
  publisher: text("publisher"),
  description: text("description"),
  iconKey: text("icon_key"),
  latestKnownVersion: integer("latest_known_version"),
  latestVersionSource: text("latest_version_source"),
  updatedAt: integer("updated_at").notNull(),
});

export const homebrew = sqliteTable("homebrew", {
  fileId: integer("file_id")
    .primaryKey()
    .references(() => files.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  publisher: text("publisher"),
  version: text("version"),
  iconKey: text("icon_key"),
});

export const admin = sqliteTable("admin", {
  id: integer("id").primaryKey(),
  username: text("username").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    /** SHA-256 of the session token, so a database copy cannot be used to sign in. */
    id: text("id").primaryKey(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    userAgent: text("user_agent"),
  },
  (t) => [index("sessions_expires_idx").on(t.expiresAt)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const titledbVersions = sqliteTable(
  "titledb_versions",
  {
    titleId: text("title_id")
      .notNull()
      .references(() => titledbTitles.titleId, { onDelete: "cascade" }),
    version: integer("version").notNull(),
  },
  (t) => [uniqueIndex("titledb_versions_idx").on(t.titleId, t.version)],
);

export const devices = sqliteTable(
  "devices",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    uuid: text("uuid").notNull(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    fw: text("fw"),
    ams: text("ams"),
    appVersion: text("app_version"),
    lastSeen: integer("last_seen"),
    transport: text("transport", { enum: TRANSPORTS }),
    sdFree: integer("sd_free"),
    sdTotal: integer("sd_total"),
    nandFree: integer("nand_free"),
    nandTotal: integer("nand_total"),
    revokedAt: integer("revoked_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("devices_uuid_idx").on(t.uuid),
    uniqueIndex("devices_token_hash_idx").on(t.tokenHash),
  ],
);

export const pairingCodes = sqliteTable("pairing_codes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  codeHash: text("code_hash").notNull(),
  expiresAt: integer("expires_at").notNull(),
  attempts: integer("attempts").notNull().default(0),
  createdAt: integer("created_at").notNull(),
});

export const deviceTitles = sqliteTable(
  "device_titles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    deviceId: integer("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    storage: text("storage", { enum: STORAGES }).notNull(),
    titleId: text("title_id").notNull(),
    version: integer("version").notNull(),
    type: text("type", { enum: CONTENT_TYPES }).notNull(),
    applicationId: text("application_id").notNull(),
  },
  (t) => [
    uniqueIndex("device_titles_unique_idx").on(t.deviceId, t.titleId, t.storage),
    index("device_titles_device_idx").on(t.deviceId),
  ],
);

export const installJobs = sqliteTable(
  "install_jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    deviceId: integer("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    contentMetaId: integer("content_meta_id").notNull(),
    fileId: integer("file_id").notNull(),
    titleId: text("title_id").notNull(),
    version: integer("version").notNull(),
    type: text("type", { enum: CONTENT_TYPES }).notNull(),
    name: text("name").notNull(),
    size: integer("size").notNull(),
    format: text("format", { enum: FILE_FORMATS }).notNull(),
    target: text("target", { enum: INSTALL_TARGETS }).notNull(),
    source: text("source", { enum: JOB_SOURCES }).notNull().default("web"),
    position: integer("position").notNull(),
    status: text("status", { enum: JOB_STATUSES }).notNull(),
    phase: text("phase", { enum: INSTALL_PHASES }),
    item: text("item"),
    bytesDone: integer("bytes_done").notNull().default(0),
    bps: integer("bps"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    claimedAt: integer("claimed_at"),
    completedAt: integer("completed_at"),
  },
  (t) => [
    index("install_jobs_device_idx").on(t.deviceId, t.status),
    index("install_jobs_position_idx").on(t.deviceId, t.position),
  ],
);

/**
 * Save data archives uploaded by a Switch. The archive itself is `<dataDir>/saves/<app>/<id>.tar`.
 * A save is (application, type, user, device): an account ID is only meaningful on its console.
 */
export const saveBackups = sqliteTable(
  "save_backups",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    applicationId: text("application_id").notNull(),
    /** The game's name as the console sent it, for games that are not in the library. */
    appName: text("app_name"),
    saveType: text("save_type", { enum: SAVE_TYPES }).notNull(),
    /** Account UID, 32 uppercase hex digits. Null for device saves. */
    userId: text("user_id"),
    userName: text("user_name"),
    deviceId: integer("device_id").references(() => devices.id, { onDelete: "set null" }),
    /** Copied when the backup is made, so it still reads sensibly after the console is gone. */
    deviceName: text("device_name").notNull(),
    origin: text("origin", { enum: SAVE_ORIGINS }).notNull(),
    size: integer("size").notNull(),
    dataSize: integer("data_size").notNull(),
    fileCount: integer("file_count").notNull(),
    sha256: text("sha256").notNull(),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    note: text("note"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("save_backups_save_idx").on(
      t.applicationId,
      t.saveType,
      t.userId,
      t.deviceId,
      t.createdAt,
    ),
  ],
);

export type RootRow = typeof libraryRoots.$inferSelect;
export type FileRow = typeof files.$inferSelect;
export type ContentMetaRow = typeof contentMetas.$inferSelect;
export type ContentMetaInsert = typeof contentMetas.$inferInsert;
export type DeviceRow = typeof devices.$inferSelect;
export type JobRow = typeof installJobs.$inferSelect;
export type SaveBackupRow = typeof saveBackups.$inferSelect;
