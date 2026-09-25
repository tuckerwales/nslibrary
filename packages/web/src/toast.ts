import { useSyncExternalStore } from "react";

export type ToastTone = "error" | "success";

export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

const DISMISS_AFTER_MS = 8000;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function dismissToast(id: number) {
  toasts = toasts.filter((toast) => toast.id !== id);
  emit();
}

/** Shows a short message in the corner, an error unless told otherwise. Repeats are dropped. */
export function showToast(message: string, tone: ToastTone = "error") {
  if (toasts.some((toast) => toast.message === message)) return;
  const id = nextId++;
  toasts = [...toasts, { id, message, tone }];
  emit();
  setTimeout(() => dismissToast(id), DISMISS_AFTER_MS);
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => toasts,
  );
}
