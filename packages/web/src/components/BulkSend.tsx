import type { AppDetail, InstallTarget } from "@nslib/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { appDetailQuery, useCreateJobs, useDevices } from "../api";
import { plural } from "../format";
import { showToast } from "../toast";
import { Button } from "./Button";
import { ErrorText } from "./Feedback";
import { INSTALL_TARGETS } from "./SendToSwitch";

/** What sending a whole title installs: the base game, its newest update, and all its DLC. */
export function titleInstallItems(detail: AppDetail): number[] {
  const updates = detail.contents.filter((c) => c.type === "patch");
  const newest = updates.reduce<(typeof updates)[number] | undefined>(
    (best, c) => (best === undefined || (c.version ?? -1) > (best.version ?? -1) ? c : best),
    undefined,
  );
  return detail.contents
    .filter((c) => c.type !== "patch" || c === newest)
    .map((c) => c.contentMetaId);
}

const selectClass = "h-9 min-w-0 rounded-md border border-line bg-panel px-2 text-sm text-ink";

/**
 * The bar shown while titles are selected in the library: pick a Switch and queue everything
 * each title needs in one go.
 */
export function BulkSendBar({
  selected,
  onClear,
  onDone,
}: {
  selected: string[];
  onClear: () => void;
  onDone: () => void;
}) {
  const client = useQueryClient();
  const devices = useDevices();
  const create = useCreateJobs();
  const active = useMemo(
    () => (devices.data ?? []).filter((device) => !device.revoked),
    [devices.data],
  );
  const [deviceId, setDeviceId] = useState<number | null>(null);
  const [target, setTarget] = useState<InstallTarget>("auto");
  const chosen = active.find((d) => d.id === deviceId) ?? active[0];

  const send = useMutation({
    mutationFn: async () => {
      if (!chosen) return [];
      const details = await Promise.all(
        selected.map((id) => client.fetchQuery(appDetailQuery(id))),
      );
      const items = details.flatMap(titleInstallItems);
      return create.mutateAsync({ deviceId: chosen.id, items, target });
    },
    onSuccess: (jobs) => {
      showToast(
        `Queued ${plural(jobs.length, "install")}. Follow them on the History page.`,
        "success",
      );
      onDone();
    },
    meta: { inlineError: true },
  });

  return (
    <section
      aria-label="Selected titles"
      className="sticky bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-10 mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-panel p-3 shadow-lg md:bottom-4"
    >
      <p className="mr-auto text-sm font-semibold" aria-live="polite">
        {selected.length === 0
          ? "Tick titles to send them"
          : `${plural(selected.length, "title")} selected`}
      </p>
      {devices.isPending ? null : active.length === 0 ? (
        <p className="text-sm text-muted">
          <Link to="/devices" className="text-accent hover:underline">
            Pair a Switch
          </Link>{" "}
          to send titles.
        </p>
      ) : (
        <>
          <label className="flex items-center gap-2 text-sm text-muted">
            <span className="sr-only sm:not-sr-only">To</span>
            <select
              className={selectClass}
              value={chosen?.id ?? ""}
              onChange={(e) => setDeviceId(Number(e.target.value))}
            >
              {active.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                  {device.online ? "" : " (offline)"}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-muted">
            <span className="sr-only">Install to</span>
            <select
              className={selectClass}
              value={target}
              onChange={(e) => setTarget(e.target.value as InstallTarget)}
            >
              {INSTALL_TARGETS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <Button
            disabled={selected.length === 0 || send.isPending}
            onClick={() => send.mutate()}
            title="Queues each title's base game, newest update, and DLC"
          >
            {send.isPending ? "Queuing…" : "Send to Switch"}
          </Button>
        </>
      )}
      <Button variant="ghost" className="px-3" onClick={onClear}>
        Cancel
      </Button>
      <ErrorText className="w-full text-sm">{send.error?.message}</ErrorText>
    </section>
  );
}
