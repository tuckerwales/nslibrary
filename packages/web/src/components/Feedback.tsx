import { type ReactNode, useEffect, useState } from "react";

/** Error text announced to screen readers when it appears. */
export function ErrorText({
  children,
  className = "mt-2 text-sm",
}: {
  children: ReactNode;
  className?: string;
}) {
  if (!children) return null;
  return (
    <p role="alert" className={`text-danger ${className}`}>
      {children}
    </p>
  );
}

export function LoadError({ error }: { error: Error }) {
  return <ErrorText className="">{error.message}</ErrorText>;
}

const LOADING_DELAY_MS = 300;

/** A loading indicator that only appears if loading takes long enough to notice. */
export function Loading({ className = "" }: { className?: string }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), LOADING_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div role="status" className={`flex items-center gap-2 text-muted ${className}`}>
      {visible && (
        <>
          <span
            aria-hidden="true"
            className="size-4 animate-spin rounded-full border-2 border-line border-t-accent"
          />
          Loading…
        </>
      )}
    </div>
  );
}
