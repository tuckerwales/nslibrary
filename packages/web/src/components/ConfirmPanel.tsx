import { type ReactNode, useEffect, useRef } from "react";
import { Button } from "./Button";

/**
 * An inline confirmation for destructive actions. Takes focus when it opens, closes on Escape,
 * and hands focus back to whatever opened it.
 */
export function ConfirmPanel({
  label,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
  children,
}: {
  label: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return (
    <div
      ref={panel}
      role="alertdialog"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onCancel();
        }
      }}
      className="mt-4 max-w-md rounded-md bg-danger-soft p-4"
    >
      {children}
      <div className="mt-3 flex gap-2">
        <Button variant="danger" disabled={busy} onClick={onConfirm}>
          {confirmLabel}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
