import { dismissToast, useToasts } from "../toast";

export function Toaster() {
  const toasts = useToasts();
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-end gap-2 sm:left-auto sm:w-96"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="pointer-events-auto flex w-full items-start gap-3 rounded-md border border-line bg-panel p-3 text-sm shadow-lg"
        >
          <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full bg-danger" />
          <p className="min-w-0 flex-1">{toast.message}</p>
          <button
            type="button"
            className="-my-1 rounded px-1.5 py-1 text-muted hover:text-ink"
            aria-label="Dismiss"
            onClick={() => dismissToast(toast.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
