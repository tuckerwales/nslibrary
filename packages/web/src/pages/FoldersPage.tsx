import type { LibraryRoot, ScanProgress } from "@nslib/shared";
import { type FormEvent, useId, useState } from "react";
import { useAddRoot, useRemoveRoot, useRoots, useScanRoot, useUpdateRoot } from "../api";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Card, CardBody } from "../components/Card";
import { ConfirmPanel } from "../components/ConfirmPanel";
import { ErrorText, LoadError, Loading } from "../components/Feedback";
import { inputClass, Switch } from "../components/Field";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { ProgressBar } from "../components/ProgressBar";
import { RelativeTime } from "../components/RelativeTime";
import { formatBytes, plural } from "../format";

function scanMessage(scan: ScanProgress): string {
  if (scan.state === "idle") return "";
  return scan.state === "parsing" && scan.total > 0
    ? `Reading files: ${scan.done} of ${scan.total}`
    : "Looking for files…";
}

function ScanStatus({ scan, path }: { scan: ScanProgress; path: string }) {
  const labelId = useId();
  const determinate = scan.state === "parsing" && scan.total > 0;
  const percent = determinate ? Math.round((scan.done / scan.total) * 100) : 0;
  return (
    <div className={scan.state === "idle" ? "" : "mt-3 max-w-md"}>
      {/* Always rendered so screen readers announce when a scan starts. */}
      <p id={labelId} className="text-sm" aria-live="polite">
        {scanMessage(scan)}
      </p>
      {scan.state !== "idle" && (
        <ProgressBar
          className="mt-1.5"
          percent={determinate ? percent : null}
          label={`Scanning ${path}`}
          describedBy={labelId}
        />
      )}
    </div>
  );
}

function Summary({ root }: { root: LibraryRoot }) {
  if (!root.enabled) return <>Not included in the library.</>;
  const counts = `${plural(root.fileCount, "file")}, ${formatBytes(root.totalSize)}`;
  return root.lastScanAt ? (
    <>
      {counts}. Last scanned <RelativeTime timestamp={root.lastScanAt} />.
    </>
  ) : (
    <>{counts}. Not scanned yet.</>
  );
}

function FolderRow({ root }: { root: LibraryRoot }) {
  const update = useUpdateRoot();
  const remove = useRemoveRoot();
  const scan = useScanRoot();
  const [confirming, setConfirming] = useState(false);
  const scanning = root.scan.state !== "idle";

  return (
    <li className="rounded-lg border border-line bg-panel p-4 shadow-card md:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <span className="mt-0.5 text-muted">
            <Icon name="folder" size={20} />
          </span>
          <div className="min-w-0">
            <h2 className="flex flex-wrap items-center gap-2 text-lg break-all semi-condensed">
              {root.path}
              {root.missingCount > 0 && root.enabled && (
                <Badge tone="warning">{root.missingCount} missing</Badge>
              )}
            </h2>
            <p className="text-sm text-muted">
              <Summary root={root} />
            </p>
          </div>
        </div>
        <div className="flex gap-1">
          <Button
            variant="secondary"
            disabled={scanning || !root.enabled || scan.isPending}
            onClick={() => scan.mutate(root.id)}
          >
            {scanning ? "Scanning…" : "Scan now"}
          </Button>
          {/* Stays enabled so focus can return to it when the confirmation closes. */}
          <Button variant="ghost" onClick={() => setConfirming(true)} aria-expanded={confirming}>
            Remove
          </Button>
        </div>
      </div>

      <ScanStatus scan={root.scan} path={root.path} />
      {root.lastScanError && !scanning && (
        <p className="mt-2 text-sm text-danger">{root.lastScanError}</p>
      )}

      <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4 md:flex-row md:gap-10">
        <Switch
          label="Include in library"
          checked={root.enabled}
          disabled={update.isPending}
          onChange={(enabled) => update.mutate({ id: root.id, patch: { enabled } })}
        />
        <Switch
          label="Check for changes regularly"
          hint="Turn on for network shares, where new files aren't always noticed."
          checked={root.usePolling}
          disabled={update.isPending}
          onChange={(usePolling) => update.mutate({ id: root.id, patch: { usePolling } })}
        />
      </div>

      {confirming && (
        <ConfirmPanel
          label="Remove folder"
          confirmLabel="Remove folder"
          busy={remove.isPending}
          onConfirm={() => remove.mutate(root.id)}
          onCancel={() => setConfirming(false)}
        >
          <p>Remove this folder from the library? Your files stay on disk.</p>
        </ConfirmPanel>
      )}
    </li>
  );
}

export function FoldersPage() {
  const roots = useRoots();
  const add = useAddRoot();
  const [path, setPath] = useState("");
  const canPick = typeof window !== "undefined" && window.nslib !== undefined;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    add.mutate({ path }, { onSuccess: () => setPath("") });
  };

  return (
    <>
      <PageHeader title="Folders">
        <p>
          NSLibrary reads games from these folders and watches them for changes. It never modifies
          your files.
        </p>
      </PageHeader>

      <Card className="max-w-3xl">
        <CardBody>
          <form onSubmit={submit}>
            <label htmlFor="folder-path" className="block text-sm font-semibold">
              Add a folder
            </label>
            <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
              <input
                id="folder-path"
                className={inputClass}
                placeholder="/library/games"
                required
                aria-describedby="folder-path-hint"
                value={path}
                onChange={(e) => {
                  setPath(e.target.value);
                  if (add.error) add.reset();
                }}
              />
              {canPick && (
                <Button
                  variant="secondary"
                  className="h-10"
                  onClick={() => {
                    void window.nslib?.pickFolder().then((picked) => {
                      if (picked) setPath(picked);
                    });
                  }}
                >
                  Browse…
                </Button>
              )}
              <Button type="submit" className="h-10" disabled={add.isPending}>
                {add.isPending ? "Adding…" : "Add folder"}
              </Button>
            </div>
            <p id="folder-path-hint" className="mt-1 text-sm text-muted">
              {canPick
                ? "Pick a folder on this computer, or type its full path."
                : "Use the full path as the server sees it."}
            </p>
            <ErrorText>{add.error?.message}</ErrorText>
          </form>
        </CardBody>
      </Card>

      <div className="mt-8">
        {roots.error ? (
          <LoadError error={roots.error} />
        ) : !roots.data ? (
          <Loading />
        ) : roots.data.length > 0 ? (
          <ul className="flex flex-col gap-4">
            {roots.data.map((root) => (
              <FolderRow key={root.id} root={root} />
            ))}
          </ul>
        ) : (
          <p className="text-muted">No folders yet.</p>
        )}
      </div>
    </>
  );
}
