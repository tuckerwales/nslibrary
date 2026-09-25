import type { InstallTarget, Storage } from "@nslib/shared";

/** [free bytes, total bytes] as the Switch last reported them, or null when unknown. */
export interface ReportedSpace {
  sd: [number, number] | null;
  nand: [number, number] | null;
}

export interface SpaceDemand {
  bytes: number;
  target: InstallTarget;
}

export interface Placement {
  /** Where the install would write, or null when there is no room anywhere it may go. */
  storage: Storage | null;
  fits: boolean;
}

export interface SpacePlan {
  /** Bytes the pending installs take from each storage, in queue order. */
  queued: Record<Storage, number>;
  /** Bytes the batch takes from each storage. */
  batch: Record<Storage, number>;
  /** One per batch item, in order. */
  placements: Placement[];
}

/**
 * Plays the queue forward the way the Switch will: each install checks the free space left by the
 * ones before it, `auto` prefers the SD card, and an install that doesn't fit fails without writing
 * anything. Pending installs go first because they run first.
 */
export function planSpace(
  space: ReportedSpace,
  pending: SpaceDemand[],
  batch: SpaceDemand[],
): SpacePlan {
  const left: Record<Storage, number | null> = {
    sd: space.sd ? space.sd[0] : null,
    nand: space.nand ? space.nand[0] : null,
  };
  const queued: Record<Storage, number> = { sd: 0, nand: 0 };
  const used: Record<Storage, number> = { sd: 0, nand: 0 };

  const place = (demand: SpaceDemand, into: Record<Storage, number>): Placement => {
    const room = (storage: Storage) => {
      const free = left[storage];
      return free !== null && demand.bytes <= free;
    };
    const take = (storage: Storage): Placement => {
      left[storage] = (left[storage] ?? 0) - demand.bytes;
      into[storage] += demand.bytes;
      return { storage, fits: true };
    };
    if (demand.target === "auto") {
      if (room("sd")) return take("sd");
      if (room("nand")) return take("nand");
      return { storage: null, fits: false };
    }
    if (room(demand.target)) return take(demand.target);
    return { storage: left[demand.target] === null ? null : demand.target, fits: false };
  };

  for (const demand of pending) place(demand, queued);
  const placements = batch.map((demand) => place(demand, used));
  return { queued, batch: used, placements };
}
