import { useSyncExternalStore } from "react";
import { relativeTime } from "../format";

const TICK_MS = 30_000;

let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** The current time, updated every 30 seconds while anything is showing it. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now);
}

/** "5 min ago", kept current, with the exact time on hover. */
export function RelativeTime({ timestamp }: { timestamp: number }) {
  const current = useNow();
  const date = new Date(timestamp);
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString()}>
      {relativeTime(timestamp, Math.max(current, Date.now()))}
    </time>
  );
}
