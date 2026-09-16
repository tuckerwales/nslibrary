import type { DeviceSummary, PairingCode, WebJob } from "@nslib/shared";
import { type FormEvent, useEffect, useState } from "react";
import {
  useCancelJob,
  useDevices,
  useJobs,
  usePairingCode,
  useRenameDevice,
  useRevokeDevice,
} from "../api";
import { Button } from "../components/Button";
import { inputClass } from "../components/Field";
import { LoadError, PageHeader } from "../components/PageHeader";
import { formatBytes, relativeTime, updateLabel } from "../format";

function formatCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

function countdown(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

function jobLabel(job: WebJob): string {
  if (job.type === "patch") return `${job.name} · ${updateLabel(job.version)}`;
  if (job.type === "addon") return job.name;
  return job.name;
}

function PairingPanel() {
  const pair = usePairingCode();
  const [code, setCode] = useState<PairingCode | null>(null);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!code) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [code]);

  const expired = code !== null && now >= code.expiresAt;

  return (
    <section className="max-w-2xl">
      <h2 className="text-xl">Pair a Switch</h2>
      <p className="mt-2 text-muted">
        On the Switch, open NSLibrary and enter this code. It lasts five minutes and is tried at
        most five times.
      </p>
      {code && !expired ? (
        <div className="mt-4">
          <p className="sr-only" aria-live="polite">
            Pairing code {formatCode(code.code)}
          </p>
          <p className="text-3xl font-bold tracking-[0.2em] condensed" aria-hidden="true">
            {formatCode(code.code)}
          </p>
          <p className="mt-2 text-sm text-muted">Expires in {countdown(code.expiresAt, now)}</p>
        </div>
      ) : expired ? (
        <p className="mt-4 text-sm text-muted">That code expired. Generate a new one.</p>
      ) : null}
      <Button
        className="mt-4"
        disabled={pair.isPending}
        onClick={() =>
          pair.mutate(undefined, {
            onSuccess: (next) => {
              setCode(next);
              setNow(Date.now());
            },
          })
        }
      >
        {pair.isPending ? "Generating…" : code && !expired ? "New code" : "Show pairing code"}
      </Button>
      {pair.error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {pair.error.message}
        </p>
      )}
    </section>
  );
}

function DeviceRow({ device, jobs }: { device: DeviceSummary; jobs: WebJob[] }) {
  const rename = useRenameDevice();
  const revoke = useRevokeDevice();
  const cancel = useCancelJob();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name);
  const [confirming, setConfirming] = useState(false);
  const mine = jobs.filter((job) => job.deviceId === device.id);
  const active = mine.filter(
    (job) => job.status === "queued" || job.status === "claimed" || job.status === "running",
  );
  const recent = mine
    .filter((job) => job.status === "done" || job.status === "failed" || job.status === "cancelled")
    .slice(-5)
    .reverse();
  const lastFinished = recent[0];

  const saveName = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed === device.name) {
      setEditing(false);
      setName(device.name);
      return;
    }
    rename.mutate(
      { id: device.id, name: trimmed },
      {
        onSuccess: () => setEditing(false),
      },
    );
  };

  return (
    <li className="border-b border-line py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {editing ? (
            <form onSubmit={saveName} className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                className={`${inputClass} max-w-xs`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                aria-label="Switch name"
              />
              <Button type="submit" disabled={rename.isPending}>
                Save
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setName(device.name);
                }}
              >
                Cancel
              </Button>
            </form>
          ) : (
            <h2 className="text-lg semi-condensed">
              {device.name}
              {device.revoked && (
                <span className="ml-2 text-sm font-normal text-danger">Revoked</span>
              )}
            </h2>
          )}
          <p className="text-sm text-muted">
            {device.online ? "Online" : "Offline"}
            {device.lastSeen ? ` · last seen ${relativeTime(device.lastSeen)}` : ""}
            {device.fw ? ` · firmware ${device.fw}` : ""}
            {device.ams ? ` · AMS ${device.ams}` : ""}
          </p>
        </div>
        {!device.revoked && (
          <div className="flex gap-1">
            <Button variant="secondary" onClick={() => setEditing(true)} disabled={editing}>
              Rename
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(true)} disabled={confirming}>
              Revoke
            </Button>
          </div>
        )}
      </div>

      {confirming && (
        <div
          role="alertdialog"
          aria-label="Revoke Switch"
          className="mt-4 max-w-md rounded-md bg-danger-soft p-4"
        >
          <p>Revoke this Switch? It will need a new pairing code to connect again.</p>
          <div className="mt-3 flex gap-2">
            <Button
              variant="danger"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(device.id, { onSuccess: () => setConfirming(false) })}
            >
              Revoke
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {(rename.error || revoke.error || cancel.error) && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {(rename.error ?? revoke.error ?? cancel.error)?.message}
        </p>
      )}

      {active.length > 0 && (
        <ul className="mt-4 max-w-xl">
          {active.map((job) => (
            <li key={job.id} className="flex items-baseline justify-between gap-3 py-1 text-sm">
              <span>
                {jobLabel(job)}
                <span className="text-muted">
                  {" "}
                  · {job.status}
                  {job.status === "running" && job.size > 0
                    ? ` · ${formatBytes(job.bytesDone)} of ${formatBytes(job.size)}`
                    : ""}
                </span>
              </span>
              <Button variant="ghost" className="h-8 px-2" onClick={() => cancel.mutate(job.id)}>
                Cancel
              </Button>
            </li>
          ))}
        </ul>
      )}

      {lastFinished && active.length === 0 && (
        <p className="mt-3 text-sm text-muted">
          Last install: {jobLabel(lastFinished)} ({lastFinished.status})
        </p>
      )}
    </li>
  );
}

export function DevicesPage() {
  const devices = useDevices();
  const jobs = useJobs();
  const list = devices.data ?? [];

  return (
    <>
      <PageHeader title="Devices">
        <p>
          Pair a modded Switch to browse this library and install titles over the LAN. USB pairing
          comes later.
        </p>
      </PageHeader>

      <PairingPanel />

      <section className="mt-12">
        <h2 className="text-xl">Switches</h2>
        {devices.error ? (
          <LoadError error={devices.error} />
        ) : list.length > 0 ? (
          <ul className="mt-3 border-t border-line">
            {list.map((device) => (
              <DeviceRow key={device.id} device={device} jobs={jobs.data ?? []} />
            ))}
          </ul>
        ) : devices.data ? (
          <p className="mt-3 text-muted">No Switches paired yet.</p>
        ) : null}
      </section>
    </>
  );
}
