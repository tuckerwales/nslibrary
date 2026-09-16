import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
