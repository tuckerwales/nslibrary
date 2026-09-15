import "@tanstack/react-query";

declare module "@tanstack/react-query" {
  interface Register {
    mutationMeta: {
      /** The page shows this mutation's error next to its form, so skip the global toast. */
      inlineError?: boolean;
    };
  }
}
