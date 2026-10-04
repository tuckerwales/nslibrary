import type { ReactNode } from "react";

const TONES = {
  warning: "border-l-dlc",
  danger: "border-l-danger",
  info: "border-l-accent",
};

/** A note that stands apart from the page, like a missing-keys hint or a title's problems. */
export function Callout({
  tone = "warning",
  className = "",
  children,
}: {
  tone?: keyof typeof TONES;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`max-w-[75ch] rounded-md border border-l-4 border-line bg-panel px-4 py-3 shadow-card ${TONES[tone]} ${className}`}
    >
      {children}
    </div>
  );
}
