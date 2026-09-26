/**
 * A thin progress bar. With `percent` null it sweeps, for work whose length isn't known yet.
 */
export function ProgressBar({
  percent,
  label,
  describedBy,
  className = "",
}: {
  percent: number | null;
  label: string;
  describedBy?: string;
  className?: string;
}) {
  return (
    <div
      className={`h-1.5 overflow-hidden rounded-full bg-line ${className}`}
      role="progressbar"
      aria-label={label}
      aria-describedby={describedBy}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
    >
      {percent === null ? (
        <div className="scan-sweep h-full w-2/5 rounded-full bg-accent" />
      ) : (
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-500"
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      )}
    </div>
  );
}
