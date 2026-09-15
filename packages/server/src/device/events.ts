import type { DeviceEvent, EventsResponse } from "@nslib/shared";

interface LoggedEvent {
  id: number;
  deviceId: number | null;
  event: DeviceEvent;
}

interface Waiter {
  deviceId: number;
  afterId: number;
  resolve: (entries: LoggedEvent[]) => void;
}

const MAX_EVENTS = 2000;

/** In-memory per-device event log used by the device long-poll. */
export class DeviceEventLog {
  #nextId = 1;
  #events: LoggedEvent[] = [];
  #waiters = new Set<Waiter>();

  append(deviceId: number | null, event: DeviceEvent): number {
    const id = this.#nextId++;
    const entry: LoggedEvent = { id, deviceId, event };
    this.#events.push(entry);
    if (this.#events.length > MAX_EVENTS) {
      this.#events.splice(0, this.#events.length - MAX_EVENTS);
    }
    for (const waiter of [...this.#waiters]) {
      if (entry.deviceId !== null && entry.deviceId !== waiter.deviceId) continue;
      if (entry.id <= waiter.afterId) continue;
      this.#waiters.delete(waiter);
      waiter.resolve([entry]);
    }
    return id;
  }

  head(): number {
    return this.#nextId - 1;
  }

  since(deviceId: number, cursor: number): LoggedEvent[] {
    return this.#events.filter(
      (entry) => entry.id > cursor && (entry.deviceId === null || entry.deviceId === deviceId),
    );
  }

  /**
   * Returns events after `cursor`. If none are ready and `waitMs` > 0, waits until one arrives,
   * the timeout fires, or `signal` aborts (client cancelled the long-poll).
   */
  wait(
    deviceId: number,
    cursor: number,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<EventsResponse> {
    const existing = this.since(deviceId, cursor);
    if (existing.length > 0 || waitMs <= 0) return Promise.resolve(toResponse(existing, cursor));

    return new Promise((resolve) => {
      let settled = false;
      const finish = (entries: LoggedEvent[]) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(toResponse(entries, cursor));
      };

      const waiter: Waiter = {
        deviceId,
        afterId: cursor,
        resolve: finish,
      };

      const onAbort = () => finish([]);
      const timer = setTimeout(() => finish([]), waitMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.#waiters.delete(waiter);
        signal?.removeEventListener("abort", onAbort);
      };

      if (signal?.aborted) {
        finish([]);
        return;
      }
      signal?.addEventListener("abort", onAbort);
      this.#waiters.add(waiter);
    });
  }
}

function toResponse(entries: LoggedEvent[], fallbackCursor: number): EventsResponse {
  const last = entries[entries.length - 1];
  return {
    cursor: String(last?.id ?? fallbackCursor),
    ev: entries.map((entry) => entry.event),
  };
}
