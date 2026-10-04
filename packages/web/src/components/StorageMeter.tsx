import type { Storage } from "@nslib/shared";
import { formatBytes } from "../format";

export const STORAGE_LABEL: Record<Storage, string> = {
  sd: "SD card",
  nand: "System memory",
};

function percentOf(part: number, total: number): string {
  if (total <= 0 || part <= 0) return "0%";
  return `${Math.min(100, (part / total) * 100)}%`;
}

/**
 * One console storage as a bar: what is already used, what queued installs will take, and what the
 * batch being sent would take, against the space the Switch last reported.
 */
export function StorageMeter({
  storage,
  free,
  total,
  queued = 0,
  batch = 0,
  short = 0,
}: {
  storage: Storage;
  free: number;
  total: number;
  /** Bytes installs already queued for the Switch will write here. */
  queued?: number;
  /** Bytes the batch being sent would write here. */
  batch?: number;
  /** Bytes of the batch that won't fit here. */
  short?: number;
}) {
  const used = Math.max(0, total - free);
  const left = free - queued - batch;
  const planned = queued > 0 || batch > 0 || short > 0;

  return (
    <div className="text-sm">
      <p className="flex flex-wrap justify-between gap-x-3">
        <span className="font-semibold">{STORAGE_LABEL[storage]}</span>
        <span className="text-muted">
          {formatBytes(free)} free of {formatBytes(total)}
        </span>
      </p>
      <div
        aria-hidden="true"
        className={`mt-1 flex h-2 overflow-hidden rounded-full bg-line ${short > 0 ? "outline outline-1 outline-danger" : ""}`}
      >
        <div className="h-full bg-muted" style={{ width: percentOf(used, total) }} />
        <div className="h-full bg-dlc" style={{ width: percentOf(queued, total) }} />
        <div className="h-full bg-accent" style={{ width: percentOf(batch, total) }} />
      </div>
      {planned && (
        <p className="mt-1 text-muted">
          {batch > 0 && (
            <>
              <span
                className="mr-1 inline-block size-2 rounded-full bg-accent"
                aria-hidden="true"
              />
              This batch {formatBytes(batch)} ·{" "}
            </>
          )}
          {queued > 0 && (
            <>
              <span className="mr-1 inline-block size-2 rounded-full bg-dlc" aria-hidden="true" />
              Already queued {formatBytes(queued)} ·{" "}
            </>
          )}
          {short > 0 ? (
            <span className="text-danger">{formatBytes(short)} more needed</span>
          ) : (
            <>{formatBytes(Math.max(0, left))} left after</>
          )}
        </p>
      )}
    </div>
  );
}
