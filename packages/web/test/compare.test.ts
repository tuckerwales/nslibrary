import { describe, expect, it } from "vitest";
import { compareWithDevice } from "../src/compare";
import { app, device } from "./fixtures";

const ID = "0100000000010000";

describe("compareWithDevice", () => {
  it("lists newer library updates than the installed one", () => {
    const result = compareWithDevice(
      device({
        titles: [
          { titleId: ID, version: 0, type: "application", storage: "sd", applicationId: ID },
          {
            titleId: "0100000000010800",
            version: 65536,
            type: "patch",
            storage: "sd",
            applicationId: ID,
          },
        ],
      }),
      [app({ updateVersions: [196608, 65536] })],
    );
    expect(result.updates).toMatchObject([{ have: 65536, want: 196608 }]);
    expect(result.missing).toEqual([]);
  });

  it("ignores DLC versions when working out the installed update", () => {
    const result = compareWithDevice(
      device({
        titles: [
          { titleId: ID, version: 0, type: "application", storage: "sd", applicationId: ID },
          {
            titleId: "0100000000011001",
            version: 262144,
            type: "addon",
            storage: "sd",
            applicationId: ID,
          },
        ],
      }),
      [app({ updateVersions: [196608] })],
    );
    expect(result.updates).toMatchObject([{ have: 0, want: 196608 }]);
  });

  it("counts a title with only DLC installed as not on the Switch", () => {
    const result = compareWithDevice(
      device({
        titles: [
          {
            titleId: "0100000000011001",
            version: 0,
            type: "addon",
            storage: "sd",
            applicationId: ID,
          },
        ],
      }),
      [app(), app({ applicationId: "0100000000020000", hasBase: false })],
    );
    expect(result.missing.map((a) => a.applicationId)).toEqual([ID]);
  });
});
