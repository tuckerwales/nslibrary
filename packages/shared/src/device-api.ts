/**
 * Device API schemas (`/api/device/v1`). The Switch always initiates requests; the same
 * messages travel over HTTP or inside USB frames. Catalog payloads use short keys and
 * tuples to keep JSON parsing cheap on the console.
 */
import { z } from "zod";
import { ERROR_CODES } from "./errors";

const titleId = z.string().regex(/^[0-9A-F]{16}$/, "title ID must be 16 uppercase hex digits");
const u32 = z.number().int().min(0).max(0xffffffff);
const byteCount = z.number().int().nonnegative();
const rowId = z.number().int().positive();
const revision = z.number().int().nonnegative();
const shortText = z.string().max(64);

export const ContainerFormatSchema = z.enum(["nsp", "nsz", "xci", "xcz", "nro"]);
export const ContentMetaTypeSchema = z.enum(["application", "patch", "addon"]);
export const StorageSchema = z.enum(["sd", "nand"]);
export const InstallTargetSchema = z.enum(["sd", "nand", "auto"]);
export const JobStatusSchema = z.enum([
  "queued",
  "claimed",
  "running",
  "done",
  "failed",
  "cancelled",
  "interrupted",
]);
export const InstallPhaseSchema = z.enum([
  "preflight",
  "ticket",
  "meta",
  "content",
  "commit",
  "record",
]);

export const ErrorBodySchema = z.object({
  error: z.object({ code: z.enum(ERROR_CODES), msg: z.string() }),
});

export const DeviceInfoSchema = z.object({
  deviceUuid: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  name: z.string().min(1).max(64),
  fw: shortText,
  amsVersion: shortText,
  appVersion: shortText,
});

export const PairRequestSchema = DeviceInfoSchema.extend({
  code: z.string().regex(/^\d{6}$/),
});

export const PairResponseSchema = z.object({
  /** 32 random bytes, base64url without padding. */
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  deviceId: rowId,
  serverId: z.string().min(1),
  serverName: z.string(),
});

export const HelloResponseSchema = z.object({
  serverId: z.string().min(1),
  serverName: z.string(),
  proto: z.number().int().positive(),
  catalogRev: revision,
  caps: z.array(z.string()),
  /** Latest Switch app version the server can serve (`GET /update`). */
  appLatest: z.string().optional(),
});

/** [free bytes, total bytes] */
const SpaceSchema = z.tuple([byteCount, byteCount]);

/** [titleId, version, type, storage] */
export const InstalledTitleSchema = z.tuple([titleId, u32, ContentMetaTypeSchema, StorageSchema]);

export const DeviceStateSchema = z.object({
  fw: shortText,
  ams: shortText,
  space: z.object({ sd: SpaceSchema.nullable(), nand: SpaceSchema }),
  titles: z.array(InstalledTitleSchema),
});

/** [version, contentMetaId, size, format] */
export const CatalogContentRefSchema = z.tuple([u32, rowId, byteCount, ContainerFormatSchema]);

/** [titleId, version, name, contentMetaId, size] */
export const CatalogAddonSchema = z.tuple([titleId, u32, z.string(), rowId, byteCount]);

export const CatalogAppSchema = z.object({
  /** application ID */
  i: titleId,
  /** name */
  n: z.string(),
  /** publisher */
  p: z.string().optional(),
  /** icon revision; null when no icon is available */
  ic: revision.nullable(),
  /** required system version of the newest owned content */
  rsv: u32.optional(),
  /** base game, if owned */
  b: CatalogContentRefSchema.nullable(),
  /** updates, newest first */
  u: z.array(CatalogContentRefSchema),
  /** DLC */
  d: z.array(CatalogAddonSchema),
});

export const CatalogResponseSchema = z.object({
  rev: revision,
  /** true when `apps` is a full listing rather than changes since the requested revision */
  full: z.boolean(),
  apps: z.array(CatalogAppSchema),
  /** application IDs removed since the requested revision */
  del: z.array(titleId),
  next: z.string().nullable(),
});

export const JobSchema = z.object({
  id: rowId,
  contentMetaId: rowId,
  fileId: rowId,
  titleId,
  version: u32,
  type: ContentMetaTypeSchema,
  name: z.string(),
  size: byteCount,
  format: ContainerFormatSchema,
  target: InstallTargetSchema,
  status: JobStatusSchema,
});

export const DeviceEventSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("job.queued"), job: JobSchema }),
  z.object({ t: z.literal("job.cancel"), id: rowId }),
  z.object({ t: z.literal("catalog"), rev: revision }),
]);

export const EventsResponseSchema = z.object({
  cursor: z.string(),
  ev: z.array(DeviceEventSchema),
});

export const CreateJobRequestSchema = z.object({
  contentMetaId: rowId,
  target: InstallTargetSchema,
});

export const ClaimJobResponseSchema = z.object({ job: JobSchema });

export const JobProgressRequestSchema = z.object({
  phase: InstallPhaseSchema,
  item: z.string().max(128).optional(),
  done: byteCount,
  total: byteCount,
  bps: z.number().nonnegative(),
});

export const JobCompleteRequestSchema = z.object({
  ok: z.boolean(),
  /** libnx Result code, e.g. "0x2A8" */
  result: z
    .string()
    .regex(/^0x[0-9A-Fa-f]{1,8}$/)
    .optional(),
  msg: z.string().max(512).optional(),
});

export const DiscoveryReplySchema = z.object({
  serverId: z.string().min(1),
  name: z.string(),
  port: z.number().int().min(1).max(65535),
  proto: z.number().int().positive(),
  /** True when the HTTP port speaks TLS. */
  tls: z.boolean().optional(),
});

export const CatalogQuerySchema = z.object({
  since: z.coerce.number().int().nonnegative().optional(),
  cursor: z.string().max(32).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const EventsQuerySchema = z.object({
  cursor: z.string().max(32).optional(),
  wait: z.coerce.number().int().min(0).max(30).optional(),
});

export const DEVICE_CAPABILITIES = ["ncz-block", "icons", "events", "resume"] as const;

export type ContainerFormat = z.infer<typeof ContainerFormatSchema>;
export type Storage = z.infer<typeof StorageSchema>;
export type InstallTarget = z.infer<typeof InstallTargetSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** Jobs that are waiting for or holding a Switch. Everything else has finished. */
export function isActiveJobStatus(status: JobStatus): boolean {
  return status === "queued" || status === "claimed" || status === "running";
}
export type InstallPhase = z.infer<typeof InstallPhaseSchema>;
export type ErrorBody = z.infer<typeof ErrorBodySchema>;
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>;
export type PairRequest = z.infer<typeof PairRequestSchema>;
export type PairResponse = z.infer<typeof PairResponseSchema>;
export type HelloResponse = z.infer<typeof HelloResponseSchema>;
export type DeviceState = z.infer<typeof DeviceStateSchema>;
export type CatalogApp = z.infer<typeof CatalogAppSchema>;
export type CatalogResponse = z.infer<typeof CatalogResponseSchema>;
export type Job = z.infer<typeof JobSchema>;
export type DeviceEvent = z.infer<typeof DeviceEventSchema>;
export type EventsResponse = z.infer<typeof EventsResponseSchema>;
export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>;
export type ClaimJobResponse = z.infer<typeof ClaimJobResponseSchema>;
export type JobProgressRequest = z.infer<typeof JobProgressRequestSchema>;
export type JobCompleteRequest = z.infer<typeof JobCompleteRequestSchema>;
export type DiscoveryReply = z.infer<typeof DiscoveryReplySchema>;
export type CatalogQuery = z.infer<typeof CatalogQuerySchema>;
export type EventsQuery = z.infer<typeof EventsQuerySchema>;
