import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const FILE_FORMATS = ["nsp", "nsz", "xci", "xcz", "nro"] as const;
const PARSE_STATUSES = ["pending", "ok", "unidentified", "error"] as const;
const METADATA_SOURCES = ["filename", "ticket", "cnmt", "nacp"] as const;
const VERIFY_STATUSES = ["unverified", "ok", "bad", "partial"] as const;
const CONTENT_TYPES = ["application", "patch", "addon"] as const;
const APPLICATION_ID_SOURCES = ["exact", "derived", "guess"] as const;
const ENTRY_KINDS = ["cnmt", "nca", "ncz", "tik", "cert", "other"] as const;

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
    sha256: text("sha256"),
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

/** Metadata better than filenames (NACP with keys, or titledb). Empty until M2. */
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

export type RootRow = typeof libraryRoots.$inferSelect;
export type FileRow = typeof files.$inferSelect;
export type ContentMetaInsert = typeof contentMetas.$inferInsert;
