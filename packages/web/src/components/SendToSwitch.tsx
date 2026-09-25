import type { AppContent, InstallTarget, SpaceCheck, SpaceCheckItem } from "@nslib/shared";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useCreateJobs, useDevices, useSpaceCheck } from "../api";
import { formatBytes, plural, updateLabel } from "../format";
import { Button } from "./Button";
import { ConfirmPanel } from "./ConfirmPanel";
import { ErrorText } from "./Feedback";
import { Select } from "./Select";
import { STORAGE_LABEL, StorageMeter } from "./StorageMeter";

const TARGETS: { value: InstallTarget; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "sd", label: "SD card" },
  { value: "nand", label: "System memory" },
];

function contentLabel(content: AppContent): string {
  if (content.type === "application") return "Base game";
  if (content.type === "patch") {
    return content.version === null ? "Update, version unknown" : updateLabel(content.version);
  }
  return content.name;
}

function itemSize(item: SpaceCheckItem): string {
  return `${item.estimated ? "≈ " : ""}${formatBytes(item.bytes)}`;
}

/** Where the items that don't fit were meant to go, for the warning. */
function unfitWhere(check: SpaceCheck): string {
  if (check.target !== "auto") return STORAGE_LABEL[check.target];
  return check.sd ? "the SD card or system memory" : STORAGE_LABEL.nand;
}

/** Free space on the Switch, and what the queue and this batch would take from it. */
function SpacePreview({
  check,
  deviceName,
  stale,
  labels,
}: {
  check: SpaceCheck;
  deviceName: string;
  stale: boolean;
  /** How the content list names each item, so the warning reads the same way. */
  labels: ReadonlyMap<number, string>;
}) {
  const label = (item: SpaceCheckItem) => labels.get(item.contentMetaId) ?? item.name;
  if (!check.known) {
    return (
      <p className="mt-4 text-sm text-muted">
        {deviceName} hasn&apos;t reported its free space yet. It does each time it connects, so the
        space check starts working after that.
      </p>
    );
  }

  const unfit = check.items.filter((item) => !item.fits);
  const estimated = check.items.some((item) => item.estimated);
  const installed = check.items.filter((item) => item.installed);
  // With a fixed target, how much has to be freed there for everything to fit.
  const shortOn = (storage: "sd" | "nand") => {
    const use = check[storage];
    if (!use || check.target !== storage || unfit.length === 0) return 0;
    const wanted = check.items.reduce((sum, item) => sum + item.bytes, 0);
    return Math.max(0, use.queued + wanted - use.free);
  };

  return (
    <div className={`mt-4 transition-opacity ${stale ? "opacity-60" : ""}`}>
      <h3 className="text-sm font-semibold">Space on {deviceName}</h3>
      <div className="mt-2 flex flex-col gap-3">
        {check.sd && <StorageMeter storage="sd" {...check.sd} short={shortOn("sd")} />}
        {check.nand && <StorageMeter storage="nand" {...check.nand} short={shortOn("nand")} />}
        {!check.sd && (
          <p className="text-sm text-muted">
            No SD card reported, so installs go to system memory.
          </p>
        )}
      </div>
      {check.queuedJobs > 0 && (
        <p className="mt-2 text-sm text-muted">
          Counts {plural(check.queuedJobs, "install")} already queued for this Switch, which run
          first.
        </p>
      )}

      {unfit.length > 0 && (
        <div className="mt-3 rounded-md bg-danger-soft p-3 text-sm">
          <p className="font-semibold text-danger">
            {unfit.length === check.items.length
              ? "This won't fit"
              : `${unfit.length} of ${check.items.length} won't fit`}{" "}
            on {unfitWhere(check)}
          </p>
          <ul className="mt-1">
            {unfit.map((item) => (
              <li key={item.contentMetaId}>
                {label(item)} · {itemSize(item)}
              </li>
            ))}
          </ul>
          <p className="mt-2">
            The Switch checks again before writing and stops an install that doesn&apos;t fit. To
            make room, uninstall or move titles from the Installed tab on the Switch
            {check.target !== "auto" ? ", or choose another target" : ""}.
          </p>
        </div>
      )}

      {estimated && (
        <p className="mt-2 text-sm text-muted">
          Sizes marked ≈ are file sizes, because the installed size couldn&apos;t be read.
          Compressed files (NSZ, XCZ) take more space once installed.
        </p>
      )}
      {installed.length > 0 && (
        <p className="mt-2 text-sm text-muted">
          Already on {deviceName}: {installed.map(label).join(", ")}. Reinstalling writes little or
          nothing, so these may need less space than shown.
        </p>
      )}
    </div>
  );
}

export function SendToSwitch({ contents }: { contents: AppContent[] }) {
  const devices = useDevices();
  const send = useCreateJobs();
  const active = useMemo(
    () => (devices.data ?? []).filter((device) => !device.revoked),
    [devices.data],
  );
  const [deviceId, setDeviceId] = useState<number | null>(null);
  const [target, setTarget] = useState<InstallTarget>("auto");
  // Track what's unticked rather than ticked, so content that appears later starts ticked.
  const [unselected, setUnselected] = useState<ReadonlySet<number>>(() => new Set());
  const [confirming, setConfirming] = useState(false);

  const chosen = active.find((d) => d.id === deviceId) ?? active[0];
  const items = contents
    .filter((c) => !unselected.has(c.contentMetaId))
    .map((c) => c.contentMetaId);
  const check = useSpaceCheck(chosen?.id ?? null, items, target);
  // A placeholder answer is for the last selection: fine to show dimmed, not to decide on.
  const shown = check.data?.deviceId === chosen?.id && items.length > 0 ? check.data : undefined;
  const current = check.isPlaceholderData ? undefined : shown;
  const sizes = new Map(shown?.items.map((item) => [item.contentMetaId, item]));
  const unfitCount = current?.items.filter((item) => !item.fits).length ?? 0;
  const labels = new Map(contents.map((c) => [c.contentMetaId, contentLabel(c)]));

  if (devices.isPending) return null;
  if (active.length === 0) {
    return (
      <p className="mt-6 max-w-[65ch] text-muted">
        <Link to="/devices" className="text-accent hover:underline">
          Pair a Switch
        </Link>{" "}
        to install titles from here.
      </p>
    );
  }

  // Changing what will be sent clears the result of the last send.
  const edit = (apply: () => void) => {
    apply();
    setConfirming(false);
    if (!send.isPending) send.reset();
  };

  const queue = () => {
    if (!chosen) return;
    setConfirming(false);
    send.mutate({ deviceId: chosen.id, items, target });
  };

  const toggle = (id: number) =>
    edit(() =>
      setUnselected((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    );

  return (
    <section className="mt-8 max-w-xl border-t border-line pt-6">
      <h2 className="text-xl">Send to Switch</h2>
      <p className="mt-1 text-sm text-muted">
        Queues an install. The Switch picks the job up over the LAN or USB; the file is not copied
        to the SD card first.
      </p>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <Select
          label="Switch"
          className="min-w-0 flex-1"
          value={chosen?.id ?? ""}
          onChange={(e) => edit(() => setDeviceId(Number(e.target.value)))}
        >
          {active.map((device) => (
            <option key={device.id} value={device.id}>
              {device.name}
              {device.online ? "" : " (offline)"}
            </option>
          ))}
        </Select>
        <Select
          label="Target"
          className="sm:w-44"
          value={target}
          onChange={(e) => edit(() => setTarget(e.target.value as InstallTarget))}
        >
          {TARGETS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>
      {chosen && !chosen.online && (
        <p className="mt-2 text-sm text-muted">
          {chosen.name} is offline. The install starts the next time it connects.
        </p>
      )}

      <fieldset className="mt-4">
        <legend className="text-sm font-semibold">Content</legend>
        <ul className="mt-2">
          {contents.map((content) => (
            <li key={content.contentMetaId}>
              <label className="flex items-center gap-2 py-1 text-sm">
                <input
                  type="checkbox"
                  checked={!unselected.has(content.contentMetaId)}
                  onChange={() => toggle(content.contentMetaId)}
                />
                {contentLabel(content)}
                {sizes.has(content.contentMetaId) && (
                  <span className="text-muted">
                    · {itemSize(sizes.get(content.contentMetaId) as SpaceCheckItem)}
                  </span>
                )}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      {shown && chosen && (
        <SpacePreview
          check={shown}
          deviceName={chosen.name}
          stale={check.isPlaceholderData}
          labels={labels}
        />
      )}
      <ErrorText>{check.error?.message}</ErrorText>

      <Button
        className="mt-4"
        disabled={!chosen || items.length === 0 || send.isPending}
        aria-expanded={unfitCount > 0 ? confirming : undefined}
        onClick={() => {
          if (unfitCount > 0) setConfirming(true);
          else queue();
        }}
      >
        {send.isPending ? "Queuing…" : "Send to Switch"}
      </Button>
      {confirming && current && chosen && (
        <ConfirmPanel
          label="Send without enough space"
          confirmLabel="Send anyway"
          busy={send.isPending}
          onConfirm={queue}
          onCancel={() => setConfirming(false)}
        >
          <p>
            {unfitCount === 1 ? "One install doesn't" : `${unfitCount} installs don't`} fit on{" "}
            {unfitWhere(current)}, going by the space {chosen.name} last reported. Unless space is
            freed first, the Switch will stop {unfitCount === 1 ? "it" : "them"} before writing
            anything.
          </p>
        </ConfirmPanel>
      )}
      <div aria-live="polite">
        {send.isSuccess && (
          <p className="mt-2 text-sm text-muted">
            Queued {send.data.length === 1 ? "1 install" : `${send.data.length} installs`}. Watch
            progress on the Switch or the{" "}
            <Link to="/history" className="text-accent hover:underline">
              History
            </Link>{" "}
            page.
          </p>
        )}
      </div>
      <ErrorText>{send.error?.message}</ErrorText>
    </section>
  );
}
