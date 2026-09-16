import type { LibraryRoot, ServerEvent } from "@nslib/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { LIBRARY_QUERY_KEYS } from "./api";

const MAX_RETRY_DELAY_MS = 30_000;

/** Keeps queries fresh from the server's event stream, reconnecting with backoff. */
export function useLiveUpdates(enabled: boolean) {
  const client = useQueryClient();

  useEffect(() => {
    if (!enabled) return;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let stopped = false;

    const refreshLibrary = () => {
      for (const queryKey of LIBRARY_QUERY_KEYS) void client.invalidateQueries({ queryKey });
    };

    const handle = (event: ServerEvent) => {
      switch (event.type) {
        case "library.changed":
          refreshLibrary();
          break;
        case "roots.changed":
          void client.invalidateQueries({ queryKey: ["roots"] });
          void client.invalidateQueries({ queryKey: ["stats"] });
          break;
        case "scan.progress":
          client.setQueryData<LibraryRoot[]>(["roots"], (roots) =>
            roots?.map((root) => (root.id === event.rootId ? { ...root, scan: event.scan } : root)),
          );
          break;
        case "device.paired":
          client.setQueryData(["pairing-code"], null);
          void client.invalidateQueries({ queryKey: ["devices"] });
          break;
        case "device.online":
        case "device.offline":
          void client.invalidateQueries({ queryKey: ["devices"] });
          break;
        case "job.updated":
          void client.invalidateQueries({ queryKey: ["jobs"] });
          void client.invalidateQueries({ queryKey: ["devices"] });
          break;
      }
    };

    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/api/v1/ws`);
      socket.onopen = () => {
        // Anything could have changed while disconnected.
        if (attempts > 0) {
          refreshLibrary();
          void client.invalidateQueries({ queryKey: ["devices"] });
          void client.invalidateQueries({ queryKey: ["jobs"] });
        }
        attempts = 0;
      };
      socket.onmessage = (message) => {
        try {
          handle(JSON.parse(String(message.data)) as ServerEvent);
        } catch {
          // Ignore malformed events.
        }
      };
      socket.onclose = () => {
        if (stopped) return;
        const delay = Math.min(MAX_RETRY_DELAY_MS, 1000 * 2 ** attempts);
        attempts++;
        retryTimer = setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      socket?.close();
    };
  }, [enabled, client]);
}
