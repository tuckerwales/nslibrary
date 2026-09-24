import type { AppSummary, DeviceDetail, WebJob } from "@nslib/shared";

export function app(overrides: Partial<AppSummary> = {}): AppSummary {
  return {
    applicationId: "0100000000010000",
    name: "Example",
    publisher: null,
    iconUrl: null,
    hasBase: true,
    baseFormats: ["nsp"],
    updateVersions: [],
    addonCount: 0,
    fileCount: 1,
    totalSize: 1024,
    addedAt: 1_758_700_800_000,
    flags: [],
    ...overrides,
  };
}

export function device(overrides: Partial<DeviceDetail> = {}): DeviceDetail {
  return {
    id: 1,
    uuid: "uuid",
    name: "Living room",
    fw: null,
    ams: null,
    appVersion: null,
    lastSeen: null,
    transport: null,
    online: true,
    revoked: false,
    space: { sd: null, nand: [0, 0] },
    queuedJobs: 0,
    runningJobs: 0,
    titles: [],
    ...overrides,
  };
}

export function job(overrides: Partial<WebJob> = {}): WebJob {
  return {
    id: 1,
    deviceId: 1,
    contentMetaId: 1,
    fileId: 1,
    titleId: "0100000000010000",
    version: 0,
    type: "application",
    name: "Example",
    size: 100,
    format: "nsp",
    target: "auto",
    source: "web",
    status: "queued",
    position: 1,
    phase: null,
    item: null,
    bytesDone: 0,
    bps: null,
    error: null,
    createdAt: 1000,
    updatedAt: 1000,
    completedAt: null,
    ...overrides,
  };
}
