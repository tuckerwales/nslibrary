import type { AppContent, SpaceCheck } from "@nslib/shared";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SendToSwitch } from "../src/components/SendToSwitch";
import { device, job } from "./fixtures";
import { renderWithApp, stubApi } from "./render";

afterEach(() => vi.unstubAllGlobals());

const GB = 1024 ** 3;

const content: AppContent = {
  contentMetaId: 7,
  titleId: "0100000000010000",
  type: "application",
  version: 0,
  name: "Example",
  applicationIdSource: "exact",
  keyGeneration: null,
  requiredSystemVersion: null,
  installSize: 12 * GB,
  files: [],
};

function spaceCheck(overrides: Partial<SpaceCheck> = {}): SpaceCheck {
  return {
    deviceId: 1,
    target: "auto",
    known: true,
    sd: { free: 20 * GB, total: 64 * GB, queued: 2 * GB, batch: 12 * GB },
    nand: { free: 5 * GB, total: 26 * GB, queued: 0, batch: 0 },
    items: [
      {
        contentMetaId: 7,
        titleId: content.titleId,
        type: "application",
        version: 0,
        name: "Example",
        bytes: 12 * GB,
        estimated: false,
        storage: "sd",
        fits: true,
        installed: false,
      },
    ],
    queuedJobs: 1,
    fits: true,
    ...overrides,
  };
}

function setUp(check: SpaceCheck) {
  const fetch = stubApi({
    "/devices": [device()],
    "/devices/1/space-check": check,
    "/jobs": [job()],
  });
  renderWithApp(<SendToSwitch contents={[content]} />);
  return {
    jobPosts: () =>
      fetch.mock.calls.filter(
        ([input, init]) => String(input).endsWith("/jobs") && init?.method === "POST",
      ),
  };
}

describe("SendToSwitch space check", () => {
  it("shows what the batch and the queue take, and sends straight away when it fits", async () => {
    const page = setUp(spaceCheck());
    expect(await screen.findByText("Space on Living room")).toBeTruthy();
    expect(screen.getByText(/This batch 12\.0 GB/)).toBeTruthy();
    expect(screen.getByText(/Already queued 2\.0 GB/)).toBeTruthy();
    expect(screen.getByText(/1 install already queued/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Send to Switch" }));
    await waitFor(() => expect(page.jobPosts()).toHaveLength(1));
  });

  it("warns before sending a batch that won't fit, and sends only when confirmed", async () => {
    const base = spaceCheck();
    const page = setUp(
      spaceCheck({
        target: "sd",
        fits: false,
        sd: { free: 10 * GB, total: 64 * GB, queued: 2 * GB, batch: 0 },
        items: base.items.map((item) => ({ ...item, fits: false })),
      }),
    );
    expect(await screen.findByText(/This won't fit/)).toBeTruthy();
    expect(screen.getByText(/4\.0 GB more needed/)).toBeTruthy();
    // The warning names content the way the checkbox list does.
    expect(screen.getByText("Base game · 12.0 GB")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Send to Switch" }));
    const panel = await screen.findByRole("alertdialog", { name: "Send without enough space" });
    expect(panel.textContent).toMatch(/One install doesn't fit/);
    expect(page.jobPosts()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Send anyway" }));
    await waitFor(() => expect(page.jobPosts()).toHaveLength(1));
  });

  it("says when the Switch hasn't reported its space yet", async () => {
    setUp(spaceCheck({ known: false, sd: null, nand: null }));
    expect(await screen.findByText(/hasn't reported its free space yet/)).toBeTruthy();
  });
});
