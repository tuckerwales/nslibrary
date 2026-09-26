import { useSyncExternalStore } from "react";

export type Theme = "system" | "light" | "dark";

const THEME_KEY = "nslib.theme";
const listeners = new Set<() => void>();

function read(): Theme {
  const value = document.documentElement.dataset.theme;
  return value === "light" || value === "dark" ? value : "system";
}

/** Applies a theme and remembers it in this browser. index.html applies it again on load. */
export function setTheme(theme: Theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    if (theme === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Not remembered; the choice still applies to this visit.
  }
  for (const notify of listeners) notify();
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read,
    () => "system",
  );
}
