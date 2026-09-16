import type { AppSummary, DeviceDetail } from "@nslib/shared";

export interface DeviceComparison {
  updates: { app: AppSummary; have: number; want: number }[];
  missing: AppSummary[];
}

/**
 * Compares the library with a Switch's installed titles. Only the base game and updates count
 * towards the installed version: DLC has its own, unrelated version numbers.
 */
export function compareWithDevice(device: DeviceDetail, apps: AppSummary[]): DeviceComparison {
  const installed = new Map<string, number>();
  for (const title of device.titles) {
    if (title.type !== "application" && title.type !== "patch") continue;
    const current = installed.get(title.applicationId);
    if (current === undefined || title.version > current) {
      installed.set(title.applicationId, title.version);
    }
  }

  const result: DeviceComparison = { updates: [], missing: [] };
  for (const app of apps) {
    const have = installed.get(app.applicationId);
    const want = app.updateVersions[0];
    if (have === undefined) {
      if (app.hasBase) result.missing.push(app);
    } else if (want !== undefined && want > have) {
      result.updates.push({ app, have, want });
    }
  }
  return result;
}
