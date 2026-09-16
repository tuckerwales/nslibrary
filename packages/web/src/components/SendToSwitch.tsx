import type { AppContent, DeviceSummary, InstallTarget } from "@nslib/shared";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useCreateJobs, useDevices } from "../api";
import { updateLabel } from "../format";
import { Button } from "./Button";

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

export function SendToSwitch({ contents }: { contents: AppContent[] }) {
  const devices = useDevices();
  const send = useCreateJobs();
  const active = useMemo(
    () => (devices.data ?? []).filter((device) => !device.revoked),
    [devices.data],
  );
  const [deviceId, setDeviceId] = useState<number | null>(null);
  const [target, setTarget] = useState<InstallTarget>("auto");
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(contents.map((c) => c.contentMetaId)),
  );

  const chosen: DeviceSummary | undefined = active.find((d) => d.id === deviceId) ?? active[0];

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

  const toggle = (id: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const items = contents.filter((c) => selected.has(c.contentMetaId)).map((c) => c.contentMetaId);

  return (
    <section className="mt-8 max-w-xl border-t border-line pt-6">
      <h2 className="text-xl">Send to Switch</h2>
      <p className="mt-1 text-sm text-muted">
        Queues an install. The Switch picks the job up over the LAN; the file is not copied to the
        SD card first.
      </p>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <label className="block min-w-0 flex-1 text-sm font-semibold">
          Switch
          <select
            className="mt-1.5 h-10 w-full rounded-md border border-line bg-panel px-3 text-base font-normal text-ink"
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
        <label className="block text-sm font-semibold sm:w-44">
          Target
          <select
            className="mt-1.5 h-10 w-full rounded-md border border-line bg-panel px-3 text-base font-normal text-ink"
            value={target}
            onChange={(e) => setTarget(e.target.value as InstallTarget)}
          >
            {TARGETS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <fieldset className="mt-4">
        <legend className="text-sm font-semibold">Content</legend>
        <ul className="mt-2">
          {contents.map((content) => (
            <li key={content.contentMetaId}>
              <label className="flex items-center gap-2 py-1 text-sm">
                <input
                  type="checkbox"
                  checked={selected.has(content.contentMetaId)}
                  onChange={() => toggle(content.contentMetaId)}
                />
                {contentLabel(content)}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      <Button
        className="mt-4"
        disabled={!chosen || items.length === 0 || send.isPending}
        onClick={() => {
          if (!chosen) return;
          send.mutate({ deviceId: chosen.id, items, target });
        }}
      >
        {send.isPending ? "Queuing…" : "Send to Switch"}
      </Button>
      {send.isSuccess && (
        <p className="mt-2 text-sm text-muted">
          Queued {send.data.length === 1 ? "1 install" : `${send.data.length} installs`}. Watch
          progress on the Switch or the Devices page.
        </p>
      )}
      {send.error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {send.error.message}
        </p>
      )}
    </section>
  );
}
