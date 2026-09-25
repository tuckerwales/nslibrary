import { describe, expect, it } from "vitest";
import { planSpace } from "../src/device/space";

const GB = 1024 ** 3;

describe("planSpace", () => {
  it("prefers the SD card for auto and falls back to system memory", () => {
    const plan = planSpace(
      { sd: [10 * GB, 64 * GB], nand: [20 * GB, 26 * GB] },
      [],
      [
        { bytes: 8 * GB, target: "auto" },
        { bytes: 5 * GB, target: "auto" },
        { bytes: 1 * GB, target: "auto" },
      ],
    );
    expect(plan.placements).toEqual([
      { storage: "sd", fits: true },
      { storage: "nand", fits: true },
      { storage: "sd", fits: true },
    ]);
    expect(plan.batch).toEqual({ sd: 9 * GB, nand: 5 * GB });
  });

  it("counts queued installs first", () => {
    const plan = planSpace(
      { sd: [10 * GB, 64 * GB], nand: [2 * GB, 26 * GB] },
      [{ bytes: 9 * GB, target: "sd" }],
      [{ bytes: 2 * GB, target: "sd" }],
    );
    expect(plan.queued).toEqual({ sd: 9 * GB, nand: 0 });
    expect(plan.placements).toEqual([{ storage: "sd", fits: false }]);
    expect(plan.batch).toEqual({ sd: 0, nand: 0 });
  });

  it("does not charge space for an install that will fail", () => {
    const plan = planSpace(
      { sd: [10 * GB, 64 * GB], nand: [2 * GB, 26 * GB] },
      [],
      [
        { bytes: 12 * GB, target: "sd" },
        { bytes: 9 * GB, target: "sd" },
      ],
    );
    expect(plan.placements).toEqual([
      { storage: "sd", fits: false },
      { storage: "sd", fits: true },
    ]);
  });

  it("has nowhere to put an SD install when there is no SD card", () => {
    const plan = planSpace(
      { sd: null, nand: [20 * GB, 26 * GB] },
      [],
      [
        { bytes: 1 * GB, target: "sd" },
        { bytes: 1 * GB, target: "auto" },
      ],
    );
    expect(plan.placements).toEqual([
      { storage: null, fits: false },
      { storage: "nand", fits: true },
    ]);
  });

  it("reports nothing fitting when neither storage has room", () => {
    const plan = planSpace(
      { sd: [1 * GB, 64 * GB], nand: [1 * GB, 26 * GB] },
      [],
      [{ bytes: 2 * GB, target: "auto" }],
    );
    expect(plan.placements).toEqual([{ storage: null, fits: false }]);
  });
});
