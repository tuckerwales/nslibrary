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
