import type { DeviceSummary } from "@nslib/shared";
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevicesPage } from "../src/pages/DevicesPage";
import { renderWithApp, stubApi } from "./render";

afterEach(() => vi.unstubAllGlobals());

function device(id: number, name: string, revoked: boolean): DeviceSummary {
  return {
    id,
    uuid: `uuid-${id}`,
    name,
    fw: "22.0.0",
    ams: "1.9.0",
    appVersion: null,
    lastSeen: null,
    transport: null,
    online: false,
    revoked,
    space: { sd: null, nand: null },
    queuedJobs: 0,
    runningJobs: 0,
  };
}

describe("DevicesPage", () => {
  it("keeps revoked Switches in a collapsed section below the active ones", async () => {
    stubApi({
      "/devices": [device(1, "Old Switch", true), device(2, "Lite", false), device(3, "Sim", true)],
      "/jobs": [],
    });
    renderWithApp(<DevicesPage />);

    const summary = await screen.findByText("2 revoked Switches");
    const details = summary.closest("details");
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("Old Switch");
    expect(details?.textContent).toContain("Sim");
    expect(details?.textContent).not.toContain("Lite");
    expect(screen.getByText("Lite").closest("details")).toBeNull();
  });

  it("says nothing is paired when every Switch was revoked", async () => {
    stubApi({ "/devices": [device(1, "Old Switch", true)], "/jobs": [] });
    renderWithApp(<DevicesPage />);

    expect(await screen.findByText("1 revoked Switch")).toBeTruthy();
    expect(screen.getByText("No Switches paired yet.")).toBeTruthy();
  });
});
