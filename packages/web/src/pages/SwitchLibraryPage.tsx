import type { AppSummary, DeviceDetail, DeviceSummary } from "@nslib/shared";
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import { useApps, useDevice, useDevices } from "../api";
import { ContentStrip } from "../components/ContentStrip";
import { LoadError, PageHeader } from "../components/PageHeader";
import { TitleIcon } from "../components/TitleIcon";
import { formatBytes, updateLabel } from "../format";

function installedVersion(device: DeviceDetail, applicationId: string): number | null {
  let max: number | null = null;
  for (const title of device.titles) {
    if (title.applicationId !== applicationId) continue;
    if (max === null || title.version > max) max = title.version;
  }
  return max;
}

export function SwitchLibraryPage() {
  const [params, setParams] = useSearchParams();
  const devices = useDevices();
  const apps = useApps("", null);
  const active = useMemo(() => (devices.data ?? []).filter((d) => !d.revoked), [devices.data]);
  const selectedId = Number(params.get("device")) || active[0]?.id || null;
  const detail = useDevice(selectedId);

  const setDevice = (id: number) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set("device", String(id));
      return next;
    });
  };

  return (
    <>
      <PageHeader title="On this Switch">
        <p>
          Updates the library has that this console does not, and titles that are not installed.
        </p>
      </PageHeader>

      {devices.error ? (
        <LoadError error={devices.error} />
      ) : active.length === 0 ? (
        <p className="text-muted">
          <Link to="/devices" className="text-accent hover:underline">
            Pair a Switch
          </Link>{" "}
          to compare the library with what is installed.
        </p>
      ) : (
        <>
          <label className="block max-w-xs text-sm font-semibold">
            Switch
            <select
              className="mt-1.5 h-10 w-full rounded-md border border-line bg-panel px-3 text-base font-normal text-ink"
              value={selectedId ?? ""}
              onChange={(e) => setDevice(Number(e.target.value))}
            >
              {active.map((device: DeviceSummary) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                  {device.online ? "" : " (offline)"}
                </option>
              ))}
            </select>
          </label>

          {detail.error ? (
            <div className="mt-6">
              <LoadError error={detail.error} />
            </div>
          ) : !detail.data || !apps.data ? null : (
            <CompareSections device={detail.data} apps={apps.data} />
          )}
        </>
      )}
    </>
  );
}

function CompareSections({ device, apps }: { device: DeviceDetail; apps: AppSummary[] }) {
  const updates: { app: AppSummary; have: number; want: number }[] = [];
  const missing: AppSummary[] = [];
  for (const app of apps) {
    const have = installedVersion(device, app.applicationId);
    const want = app.updateVersions[0];
    if (have === null) {
      if (app.hasBase) missing.push(app);
      continue;
    }
    if (want !== undefined && want > have) updates.push({ app, have, want });
  }

  return (
    <>
      <section className="mt-10">
        <h2 className="text-xl">Updates</h2>
        <p className="mt-1 text-muted">
          Newer updates in the library than this Switch has installed.
        </p>
        {updates.length === 0 ? (
          <p className="mt-3 text-muted">Nothing newer in the library.</p>
        ) : (
          <ul className="mt-3 border-t border-line">
            {updates.map(({ app, have, want }) => (
              <AppRow
                key={app.applicationId}
                app={app}
                detail={`${updateLabel(have)} installed · library has ${updateLabel(want)}`}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-xl">Not on this Switch</h2>
        <p className="mt-1 text-muted">
          Base games in the library that are not in the last snapshot from this console.
        </p>
        {missing.length === 0 ? (
          <p className="mt-3 text-muted">Every base game in the library is on this Switch.</p>
        ) : (
          <ul className="mt-3 border-t border-line">
            {missing.map((app) => (
              <AppRow key={app.applicationId} app={app} detail="Not installed" />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function AppRow({ app, detail }: { app: AppSummary; detail?: string }) {
  return (
    <li className="border-b border-line">
      <Link
        to={`/apps/${app.applicationId}`}
        className="grid grid-cols-[44px_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5 px-2 py-3 hover:bg-panel md:grid-cols-[44px_minmax(0,1fr)_auto_5.5rem]"
      >
        <span className="row-span-2 md:row-span-1">
          <TitleIcon name={app.name} seed={app.applicationId} url={app.iconUrl} />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-lg font-semibold semi-condensed">{app.name}</span>
          <span className="block text-sm text-muted">{detail ?? app.applicationId}</span>
        </span>
        <ContentStrip app={app} />
        <span className="hidden text-right text-sm text-muted md:block">
          {formatBytes(app.totalSize)}
        </span>
      </Link>
    </li>
  );
}
