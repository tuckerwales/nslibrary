import react from "@vitejs/plugin-react";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    // One jsdom per worker instead of one per file; each file still gets a fresh module registry.
    pool: "vmThreads",
  },
});
