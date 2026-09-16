/** Every query key, so invalidations can't drift from the queries they target. */
export const queryKeys = {
  auth: ["auth"],
  stats: ["stats"],
  apps: ["apps"],
  appList: (q: string, flag: string | null) => ["apps", q, flag],
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
  jobList: (limit: number) => ["jobs", limit],
  pairingCode: ["pairing-code"],
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
];
