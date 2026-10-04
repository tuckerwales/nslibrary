import type { ReactNode } from "react";

export type Tone = "neutral" | "success" | "warning" | "danger" | "accent";

const TONES: Record<Tone, string> = {
  neutral: "bg-line/60 text-muted",
  success: "bg-update/15 text-update",
  warning: "bg-dlc/15 text-dlc",
  danger: "bg-danger/15 text-danger",
  accent: "bg-accent/15 text-accent",
};

/** A short status label, like "Verified" or "Duplicate". */
export function Badge({
  tone = "neutral",
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={`inline-flex h-5 shrink-0 items-center rounded px-1.5 text-xs font-semibold whitespace-nowrap ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/** A count beside a heading or nav item. `alert` is for counts that need attention. */
export function Count({
  value,
  alert = false,
  label,
}: {
  value: number;
  alert?: boolean;
  /** Read by screen readers instead of the bare number, like "3 problems". */
  label?: string;
}) {
  return (
    <span
      className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 align-middle text-xs font-semibold tabular-nums ${
        alert ? "bg-danger text-panel" : "bg-line/70 text-muted"
      }`}
    >
      {label ? (
        <>
          <span aria-hidden="true">{value.toLocaleString()}</span>
          <span className="sr-only">{label}</span>
        </>
      ) : (
        value.toLocaleString()
      )}
    </span>
  );
}

/** A coloured dot with its meaning spelled out beside it. */
export function StatusDot({ tone, children }: { tone: Tone; children: ReactNode }) {
  const color = {
    neutral: "bg-muted",
    success: "bg-update",
    warning: "bg-dlc",
    danger: "bg-danger",
    accent: "bg-accent",
  }[tone];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${color}`} />
      {children}
    </span>
  );
}
