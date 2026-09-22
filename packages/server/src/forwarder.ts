import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildForwarderNsp, generateFakeKeyset } from "@nslib/fixtures";
import { headerKey, type Keyset } from "@nslib/formats";
import { FORWARDER_TITLE_ID } from "@nslib/shared";
import { ApiError } from "./api/errors";
import type { ServerConfig } from "./config";

const STUB_MAIN = Buffer.from("NSLIB-FORWARDER-STUB");

export interface ForwarderStatus {
  keys: boolean;
  loader: "real" | "stub";
  titleId: string;
  name: string;
}

export interface PackForwarderInput {
  titleId?: string;
  name?: string;
  publisher?: string;
}

function defaultIcon(): Buffer | null {
  const candidates = [
    // Copied beside the bundle (Docker, desktop app); the checkout path covers running from source.
    fileURLToPath(new URL("./assets/icon.jpg", import.meta.url)),
    fileURLToPath(new URL("../../../switch/resources/img/icon.jpg", import.meta.url)),
    fileURLToPath(new URL("../../../packages/web/public/favicon.svg", import.meta.url)),
  ];
  for (const path of candidates) {
    if (existsSync(path) && path.endsWith(".jpg")) return readFileSync(path);
  }
  return null;
}

export function forwarderStatus(config: ServerConfig, keys: Keyset | null): ForwarderStatus {
  return {
    keys: keys !== null && canPack(keys),
    loader: config.forwarderMainPath && existsSync(config.forwarderMainPath) ? "real" : "stub",
    titleId: FORWARDER_TITLE_ID,
    name: "NSLibrary",
  };
}

function canPack(keys: Keyset): boolean {
  try {
    headerKey(keys);
    return true;
  } catch {
    return false;
  }
}

export function packForwarder(
  config: ServerConfig,
  keys: Keyset | null,
  input: PackForwarderInput = {},
): { nsp: Buffer; loader: "real" | "stub" } {
  if (!keys || !canPack(keys)) {
    throw new ApiError(
      "BAD_REQUEST",
      "Upload prod.keys in Settings before generating a HOME-menu forwarder.",
    );
  }
  const titleId = (input.titleId ?? FORWARDER_TITLE_ID).toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(titleId)) {
    throw new ApiError("BAD_REQUEST", "titleId must be 16 hex digits");
  }
  const loaderPath = config.forwarderMainPath;
  const loader: "real" | "stub" = loaderPath && existsSync(loaderPath) ? "real" : "stub";
  const main = loader === "real" && loaderPath ? readFileSync(loaderPath) : STUB_MAIN;
  const packed = buildForwarderNsp({
    titleId,
    keys,
    name: input.name?.trim() || "NSLibrary",
    publisher: input.publisher?.trim() || "NSLibrary",
    icon: defaultIcon(),
    main,
  });
  return { nsp: packed.nsp, loader };
}

/** Test-only: pack with the fake keyset so unit tests need no prod.keys. */
export function packForwarderWithFakeKeys(main = STUB_MAIN): Buffer {
  return buildForwarderNsp({
    titleId: FORWARDER_TITLE_ID,
    keys: generateFakeKeyset("forwarder"),
    name: "NSLibrary",
    main,
  }).nsp;
}
