/** Every query key, so invalidations can't drift from the queries they target. */
export const queryKeys = {
  auth: ["auth"],
  stats: ["stats"],
  apps: ["apps"],
  appList: (q: string, flag: string | null, sort = "name") => ["apps", q, flag, sort],
  app: ["app"],
  appDetail: (applicationId: string) => ["app", applicationId],
  homebrew: ["homebrew"],
  problems: ["problems"],
  roots: ["roots"],
  keys: ["keys"],
  titledb: ["titledb"],
  forwarder: ["forwarder"],
  settings: ["settings"],
  /** The device list only. Details live under `device` so list refreshes don't refetch them. */
  devices: ["devices"],
  device: ["device"],
  deviceDetail: (id: number) => ["device", id],
  jobs: ["jobs"],
  /** Background verifies; kept current by `verify.updated` events. */
  verify: ["verify"],
  /** Background compressions; kept current by `compress.updated` events. */
  compress: ["compress"],
  compressSettings: ["compress-settings"],
  compressCandidates: ["compress-candidates"],
  compressFolders: ["compress-folders"],
  jobList: (limit: number) => ["jobs", limit],
  pairingCode: ["pairing-code"],
  /** Save backups; kept current by `saves.changed` events. */
  saves: ["saves"],
} as const;

/**
 * Queries derived from library contents or keys; refreshed together when the library changes.
 * Devices and jobs aren't here: they have their own events.
 */
export const LIBRARY_QUERY_KEYS = [
  queryKeys.apps,
  queryKeys.app,
  queryKeys.stats,
  queryKeys.problems,
  queryKeys.homebrew,
  queryKeys.roots,
  queryKeys.keys,
  queryKeys.titledb,
  queryKeys.forwarder,
  queryKeys.compressSettings,
  queryKeys.compressCandidates,
  queryKeys.compressFolders,
];
