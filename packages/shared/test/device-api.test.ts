import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  CatalogResponseSchema,
  DeviceStateSchema,
  ErrorBodySchema,
  EventsResponseSchema,
  HelloResponseSchema,
  JobProgressRequestSchema,
  PairRequestSchema,
  PairResponseSchema,
  SaveListQuerySchema,
  SaveListResponseSchema,
  SaveUploadQuerySchema,
  SaveUploadResponseSchema,
} from "../src/index";

const goldenDir = join(import.meta.dirname, "..", "golden", "device-api");

function golden(name: string): unknown {
  return JSON.parse(readFileSync(join(goldenDir, name), "utf8"));
}

const cases: [string, z.ZodType][] = [
  ["pair-request.json", PairRequestSchema],
  ["pair-response.json", PairResponseSchema],
  ["hello-response.json", HelloResponseSchema],
  ["state-request.json", DeviceStateSchema],
  ["catalog-response.json", CatalogResponseSchema],
  ["events-response.json", EventsResponseSchema],
  ["job-progress-request.json", JobProgressRequestSchema],
  ["error-body.json", ErrorBodySchema],
  ["save-list-response.json", SaveListResponseSchema],
  ["save-upload-response.json", SaveUploadResponseSchema],
];

describe("device API golden files", () => {
  it.each(cases)("%s matches its schema exactly", (file, schema) => {
    const value = golden(file);
    // Parsing must not strip or coerce anything, so the golden files stay a faithful contract.
    expect(schema.parse(value)).toEqual(value);
  });
});

describe("device API validation", () => {
  it("rejects lowercase title IDs", () => {
    const value = golden("state-request.json") as { titles: unknown[][] };
    value.titles[0]![0] = "0100abcdef010000";
    expect(DeviceStateSchema.safeParse(value).success).toBe(false);
  });

  it("rejects pairing codes that are not six digits", () => {
    const value = { ...(golden("pair-request.json") as object), code: "12345" };
    expect(PairRequestSchema.safeParse(value).success).toBe(false);
  });

  it("rejects unknown event types", () => {
    const value = { cursor: "1", ev: [{ t: "job.exploded", id: 1 }] };
    expect(EventsResponseSchema.safeParse(value).success).toBe(false);
  });
});

describe("save backup validation", () => {
  const upload = {
    app: "0100ABCDEF010000",
    type: "account",
    user: "0123456789ABCDEF0FEDCBA987654321",
    sha256: "a".repeat(64),
  };

  it("defaults the origin to manual", () => {
    expect(SaveUploadQuerySchema.parse(upload).origin).toBe("manual");
  });

  it("requires a user for account saves and forbids one for device saves", () => {
    expect(SaveUploadQuerySchema.safeParse({ ...upload, user: undefined }).success).toBe(false);
    expect(SaveUploadQuerySchema.safeParse({ ...upload, type: "device" }).success).toBe(false);
    expect(
      SaveUploadQuerySchema.safeParse({ ...upload, type: "device", user: undefined }).success,
    ).toBe(true);
  });

  it("rejects lowercase account IDs and uppercase hashes", () => {
    expect(
      SaveUploadQuerySchema.safeParse({ ...upload, user: upload.user.toLowerCase() }).success,
    ).toBe(false);
    expect(SaveUploadQuerySchema.safeParse({ ...upload, sha256: "A".repeat(64) }).success).toBe(
      false,
    );
  });

  it("uppercases the app filter of a listing", () => {
    expect(SaveListQuerySchema.parse({ app: "0100abcdef010000" }).app).toBe("0100ABCDEF010000");
  });
});
