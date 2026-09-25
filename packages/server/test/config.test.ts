import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const base: NodeJS.ProcessEnv = { NSLIB_DATA_DIR: "/tmp/nslib-config-test" };

describe("setup token", () => {
  it("generates one when NSLIB_SETUP_TOKEN is unset", () => {
    const config = loadConfig({ ...base });
    expect(config.setupTokenGenerated).toBe(true);
    expect(config.setupToken).toMatch(/^[A-HJ-NP-Z2-9]{5}(-[A-HJ-NP-Z2-9]{5}){3}$/);
  });

  it("generates a different token each time", () => {
    const a = loadConfig({ ...base }).setupToken;
    const b = loadConfig({ ...base }).setupToken;
    expect(a).not.toBe(b);
  });

  it("uses NSLIB_SETUP_TOKEN when it is set", () => {
    const config = loadConfig({ ...base, NSLIB_SETUP_TOKEN: "  chosen-token  " });
    expect(config.setupToken).toBe("chosen-token");
    expect(config.setupTokenGenerated).toBe(false);
  });

  it("generates one when NSLIB_SETUP_TOKEN is blank, so an empty env var is not an open server", () => {
    const config = loadConfig({ ...base, NSLIB_SETUP_TOKEN: "   " });
    expect(config.setupTokenGenerated).toBe(true);
    expect(config.setupToken).not.toBe("");
  });
});

describe("save archive limit", () => {
  it("defaults to 1 GiB", () => {
    expect(loadConfig({ ...base }).saveMaxBytes).toBe(1024 * 1024 * 1024);
  });

  it("reads NSLIB_SAVE_MAX_MB", () => {
    expect(loadConfig({ ...base, NSLIB_SAVE_MAX_MB: "64" }).saveMaxBytes).toBe(64 * 1024 * 1024);
  });

  it("rejects a limit that is not a positive integer", () => {
    expect(() => loadConfig({ ...base, NSLIB_SAVE_MAX_MB: "0" })).toThrow(/NSLIB_SAVE_MAX_MB/);
    expect(() => loadConfig({ ...base, NSLIB_SAVE_MAX_MB: "big" })).toThrow(/NSLIB_SAVE_MAX_MB/);
  });
});
