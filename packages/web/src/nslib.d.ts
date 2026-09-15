export {};

declare global {
  interface Window {
    nslib?: {
      pickFolder: () => Promise<string | null>;
    };
  }
}
