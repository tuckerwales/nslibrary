import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../src/api";
import { isRetryable } from "../src/query-client";

describe("isRetryable", () => {
  it("retries network and server errors but not client errors", () => {
    expect(isRetryable(new ApiRequestError(0, "NETWORK", "offline"))).toBe(true);
    expect(isRetryable(new ApiRequestError(503, "INTERNAL", "down"))).toBe(true);
    expect(isRetryable(new ApiRequestError(404, "NOT_FOUND", "gone"))).toBe(false);
    expect(isRetryable(new ApiRequestError(401, "UNAUTHORIZED", "expired"))).toBe(false);
  });
});
