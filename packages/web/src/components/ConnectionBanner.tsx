import { useEffect, useState } from "react";
import { useConnectionState } from "../live";

/** Brief drops are common (server restarts); only mention ones that last. */
const SHOW_AFTER_MS = 2000;

export function ConnectionBanner() {
  const state = useConnectionState();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (state !== "reconnecting") {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), SHOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <div role="status" aria-live="polite">
      {visible && (
        <p className="mb-6 border-l-2 border-danger pl-3 text-sm">
          Lost connection to the server. Reconnecting… Changes may not show until it's back.
        </p>
      )}
    </div>
  );
}
