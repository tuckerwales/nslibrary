import type { DeviceSummary, WebJob } from "@nslib/shared";
import { type FormEvent, useEffect, useState } from "react";
import {
  useCancelJob,
  useDevices,
  useDisplayedPairingCode,
  useJobs,
  usePairingCode,
  useRenameDevice,
  useRevokeDevice,
} from "../api";
import { Button } from "../components/Button";
import { ConfirmPanel } from "../components/ConfirmPanel";
import { ErrorText, LoadError, Loading } from "../components/Feedback";
import { inputClass } from "../components/Field";
import { PageHeader } from "../components/PageHeader";
import { RelativeTime } from "../components/RelativeTime";
import { activeJobs, finishedJobs, jobStatusLabel, jobTitle } from "../jobs";

function formatCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

function countdown(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

function PairingPanel() {
  const pair = usePairingCode();
  const code = useDisplayedPairingCode().data ?? null;
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!code) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [code]);

  const expired = code !== null && now >= code.expiresAt;
  const showing = code !== null && !expired;

  return (
    <section className="max-w-2xl">
      <h2 className="text-xl">Pair a Switch</h2>
      <p className="mt-2 text-muted">
        On the Switch, open NSLibrary and enter this code. It lasts five minutes and is tried at
        most five times.
      </p>
      {/* Always rendered: screen readers only announce changes to a region that already exists. */}
      <p className="sr-only" aria-live="polite">
        {showing
          ? `Pairing code ${formatCode(code.code)}`
          : expired
            ? "The pairing code expired."
            : ""}
      </p>
      {showing ? (
        <div className="mt-4" aria-hidden="true">
          <p className="text-3xl font-bold tracking-[0.2em] condensed">{formatCode(code.code)}</p>
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
            onSuccess: () => setNow(Date.now()),
          })
        }
      >
        {pair.isPending ? "Generating…" : showing ? "New code" : "Show pairing code"}
      </Button>
      <ErrorText>{pair.error?.message}</ErrorText>
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
  const active = activeJobs(mine);
  const lastFinished = finishedJobs(mine)[0];

  const stopEditing = () => {
    setEditing(false);
    setName(device.name);
  };

  const saveName = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed === device.name) {
      stopEditing();
      return;
    }
    rename.mutate({ id: device.id, name: trimmed }, { onSuccess: () => setEditing(false) });
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
                onKeyDown={(e) => {
                  if (e.key === "Escape") stopEditing();
                }}
                aria-label="Switch name"
                // biome-ignore lint/a11y/noAutofocus: focus follows the Rename button that opened this
                autoFocus
              />
              <Button type="submit" disabled={rename.isPending}>
                Save
              </Button>
              <Button variant="ghost" onClick={stopEditing}>
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
            {device.lastSeen ? (
              <>
                {" "}
                · last seen <RelativeTime timestamp={device.lastSeen} />
              </>
            ) : null}
            {device.fw ? ` · firmware ${device.fw}` : ""}
            {device.ams ? ` · AMS ${device.ams}` : ""}
          </p>
        </div>
        {!device.revoked && (
          <div className="flex gap-1">
            <Button variant="secondary" onClick={() => setEditing(true)} disabled={editing}>
              Rename
            </Button>
            {/* Stays enabled so focus can return to it when the confirmation closes. */}
            <Button variant="ghost" onClick={() => setConfirming(true)} aria-expanded={confirming}>
              Revoke
            </Button>
          </div>
        )}
      </div>

      {confirming && (
        <ConfirmPanel
          label="Revoke Switch"
          confirmLabel="Revoke"
          busy={revoke.isPending}
          onConfirm={() => revoke.mutate(device.id, { onSuccess: () => setConfirming(false) })}
          onCancel={() => setConfirming(false)}
        >
          <p>Revoke {device.name}? It will need a new pairing code to connect again.</p>
        </ConfirmPanel>
      )}

      {active.length > 0 && (
        <ul className="mt-4 max-w-xl">
          {active.map((job) => (
            <li key={job.id} className="flex items-baseline justify-between gap-3 py-1 text-sm">
              <span>
                {jobTitle(job)}
                <span className="text-muted"> · {jobStatusLabel(job)}</span>
              </span>
              <Button
                variant="ghost"
                className="h-8 px-2"
                disabled={cancel.isPending && cancel.variables === job.id}
                aria-label={`Cancel ${jobTitle(job)}`}
                onClick={() => cancel.mutate(job.id)}
              >
                Cancel
              </Button>
            </li>
          ))}
        </ul>
      )}

      {lastFinished && active.length === 0 && (
        <p className="mt-3 text-sm text-muted">
          Last install: {jobTitle(lastFinished)} ({jobStatusLabel(lastFinished).toLowerCase()})
        </p>
      )}
    </li>
  );
}

export function DevicesPage() {
  const devices = useDevices();
  const jobs = useJobs();
  const list = devices.data ?? [];
  const current = list.filter((device) => !device.revoked);
  const revoked = list.filter((device) => device.revoked);
  const jobList = jobs.data ?? [];

  return (
    <>
      <PageHeader title="Devices">
        <p>Pair a modded Switch to browse this library and install titles over the LAN or USB.</p>
      </PageHeader>

      <PairingPanel />

      <section className="mt-12">
        <h2 className="text-xl">Switches</h2>
        {devices.error ? (
          <LoadError error={devices.error} />
        ) : !devices.data ? (
          <Loading className="mt-3" />
        ) : (
          <>
            {current.length > 0 ? (
              <ul className="mt-3 border-t border-line">
                {current.map((device) => (
                  <DeviceRow key={device.id} device={device} jobs={jobList} />
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-muted">No Switches paired yet.</p>
            )}
            {/* Revoked Switches can't connect again, so keep them out of the way. */}
            {revoked.length > 0 && (
              <details className="mt-6">
                <summary className="cursor-pointer text-sm text-muted">
                  {revoked.length === 1 ? "1 revoked Switch" : `${revoked.length} revoked Switches`}
                </summary>
                <ul className="mt-3 border-t border-line">
                  {revoked.map((device) => (
                    <DeviceRow key={device.id} device={device} jobs={jobList} />
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </section>
    </>
  );
}
