import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPfs0,
  buildTicket,
  deterministicBytes,
  type FixtureFile,
  rightsIdFor,
} from "@nslib/fixtures";
import type { ServerConfig } from "../src/config";

export const makeTempDir = () => mkdtemp(join(tmpdir(), "nslib-test-"));
export const removeDir = (dir: string) => rm(dir, { recursive: true, force: true });

export interface FakeNspOptions {
  /** Title IDs to include tickets for. */
  tickets?: string[];
  seed?: string;
}

/** An NSP-shaped PFS0: meta and program NCA placeholders plus optional tickets. */
export function fakeNspEntries(options: FakeNspOptions = {}): FixtureFile[] {
  const seed = options.seed ?? "nsp";
  const ncaId = (part: string) => deterministicBytes(`${seed}:${part}:id`, 16).toString("hex");
  const entries: FixtureFile[] = [
    { name: `${ncaId("meta")}.cnmt.nca`, data: deterministicBytes(`${seed}:meta`, 0x200) },
    { name: `${ncaId("program")}.nca`, data: deterministicBytes(`${seed}:program`, 0x800) },
  ];
  for (const titleId of options.tickets ?? []) {
    const rightsId = rightsIdFor(titleId, 0x0b);
    entries.push(
      {
        name: `${rightsId.toLowerCase()}.tik`,
        data: buildTicket({ rightsId, keyGeneration: 0x0b }),
      },
      { name: `${rightsId.toLowerCase()}.cert`, data: deterministicBytes(`${seed}:cert`, 0x700) },
    );
  }
  return entries;
}

export function fakeNsp(options: FakeNspOptions = {}): Buffer {
  return buildPfs0(fakeNspEntries(options));
}

export function testConfig(dataDir: string, overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    dataDir,
    databaseFile: ":memory:",
    host: "127.0.0.1",
    port: 0,
    webDir: null,
    forcePolling: true,
    pollIntervalMs: 50,
    stabilityThresholdMs: 100,
    logLevel: false,
    trustProxy: false,
    seed: false,
    seedLibraryDir: null,
    seedKeysPath: null,
    serverName: "test",
    discoveryPort: null,
    usb: false,
    log: () => {},
    ...overrides,
  };
}
