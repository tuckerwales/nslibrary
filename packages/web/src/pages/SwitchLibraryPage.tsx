import type { AppSummary, DeviceDetail } from "@nslib/shared";
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import { useApps, useDevice, useDevices } from "../api";
import { compareWithDevice } from "../compare";
import { LoadError, Loading } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { Select } from "../components/Select";
import { TitleList } from "../components/TitleList";
import { updateLabel } from "../format";

export function SwitchLibraryPage() {
  const [params, setParams] = useSearchParams();
  const devices = useDevices();
  const apps = useApps("", null);
  const active = useMemo(() => (devices.data ?? []).filter((d) => !d.revoked), [devices.data]);
  const requested = Number(params.get("device"));
  // Ignore a stale ?device= (say, a Switch revoked since the link was made).
  const selectedId = active.find((d) => d.id === requested)?.id ?? active[0]?.id ?? null;
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
      ) : !devices.data ? (
        <Loading />
      ) : active.length === 0 ? (
        <p className="text-muted">
          <Link to="/devices" className="text-accent hover:underline">
            Pair a Switch
          </Link>{" "}
          to compare the library with what is installed.
        </p>
      ) : (
        <>
          <Select
            label="Switch"
            className="max-w-xs"
            value={selectedId ?? ""}
            onChange={(e) => setDevice(Number(e.target.value))}
          >
            {active.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
                {device.online ? "" : " (offline)"}
              </option>
            ))}
          </Select>

          {detail.error || apps.error ? (
            <div className="mt-6">
              <LoadError error={(detail.error ?? apps.error) as Error} />
            </div>
          ) : !detail.data || !apps.data ? (
            <Loading className="mt-6" />
          ) : (
            <CompareSections device={detail.data} apps={apps.data} />
          )}
        </>
      )}
    </>
  );
}

function CompareSections({ device, apps }: { device: DeviceDetail; apps: AppSummary[] }) {
  const { updates, missing } = useMemo(() => compareWithDevice(device, apps), [device, apps]);

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
          <div className="mt-3">
            <TitleList
              key={device.id}
              items={updates.map(({ app, have, want }) => ({
                app,
                detail: `${updateLabel(have)} installed · library has ${updateLabel(want)}`,
              }))}
            />
          </div>
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
          <div className="mt-3">
            <TitleList
              key={device.id}
              items={missing.map((app) => ({ app, detail: "Not installed" }))}
            />
          </div>
        )}
      </section>
    </>
  );
}
