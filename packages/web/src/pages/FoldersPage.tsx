import type { LibraryRoot, ScanProgress } from "@nslib/shared";
import { type FormEvent, useState } from "react";
import { useAddRoot, useRemoveRoot, useRoots, useScanRoot, useUpdateRoot } from "../api";
import { Button } from "../components/Button";
import { inputClass, Switch } from "../components/Field";
import { LoadError, PageHeader } from "../components/PageHeader";
import { formatBytes, plural, relativeTime } from "../format";

function ScanStatus({ scan }: { scan: ScanProgress }) {
  if (scan.state === "idle") return null;
  const determinate = scan.state === "parsing" && scan.total > 0;
  const percent = determinate ? Math.round((scan.done / scan.total) * 100) : 0;
  return (
    <div className="mt-3 max-w-md">
      <p className="text-sm" aria-live="polite">
        {determinate ? `Reading files: ${scan.done} of ${scan.total}` : "Looking for files…"}
      </p>
      <div
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={determinate ? percent : undefined}
      >
        {determinate ? (
          <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
        ) : (
          <div className="scan-sweep h-full w-2/5 rounded-full bg-accent" />
        )}
      </div>
    </div>
  );
}

function summary(root: LibraryRoot): string {
  if (!root.enabled) return "Not included in the library.";
  const parts = [`${plural(root.fileCount, "file")}, ${formatBytes(root.totalSize)}`];
  if (root.missingCount > 0) parts.push(`${root.missingCount} missing`);
  const counts = parts.join(", ");
  return root.lastScanAt
    ? `${counts}. Last scanned ${relativeTime(root.lastScanAt)}.`
    : `${counts}. Not scanned yet.`;
}

function FolderRow({ root }: { root: LibraryRoot }) {
  const update = useUpdateRoot();
  const remove = useRemoveRoot();
  const scan = useScanRoot();
  const [confirming, setConfirming] = useState(false);
  const scanning = root.scan.state !== "idle";
  const error = update.error ?? remove.error ?? scan.error;

  return (
    <li className="border-b border-line py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg break-all semi-condensed">{root.path}</h2>
          <p className="text-sm text-muted">{summary(root)}</p>
        </div>
        <div className="flex gap-1">
          <Button
            variant="secondary"
            disabled={scanning || !root.enabled || scan.isPending}
            onClick={() => scan.mutate(root.id)}
          >
            {scanning ? "Scanning…" : "Scan now"}
          </Button>
          <Button variant="ghost" onClick={() => setConfirming(true)} disabled={confirming}>
            Remove
          </Button>
        </div>
      </div>

      <ScanStatus scan={root.scan} />
      {root.lastScanError && !scanning && (
        <p className="mt-2 text-sm text-danger">{root.lastScanError}</p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error.message}
        </p>
      )}

      <div className="mt-4 flex flex-col gap-3 md:flex-row md:gap-10">
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
        <div
          role="alertdialog"
          aria-label="Remove folder"
          className="mt-4 max-w-md rounded-md bg-danger-soft p-4"
        >
          <p>Remove this folder from the library? Your files stay on disk.</p>
          <div className="mt-3 flex gap-2">
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() => remove.mutate(root.id)}
            >
              Remove folder
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

export function FoldersPage() {
  const roots = useRoots();
  const add = useAddRoot();
  const [path, setPath] = useState("");

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

      <form onSubmit={submit} className="max-w-2xl">
        <label htmlFor="folder-path" className="block text-sm font-semibold">
          Add a folder
        </label>
        <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
          <input
            id="folder-path"
            className={inputClass}
            placeholder="/library/games"
            required
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              if (add.error) add.reset();
            }}
          />
          <Button type="submit" className="h-10" disabled={add.isPending}>
            {add.isPending ? "Adding…" : "Add folder"}
          </Button>
        </div>
        <p className="mt-1 text-sm text-muted">Use the full path as the server sees it.</p>
        {add.error && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {add.error.message}
          </p>
        )}
      </form>

      <div className="mt-8">
        {roots.error ? (
          <LoadError error={roots.error} />
        ) : roots.data && roots.data.length > 0 ? (
          <ul className="border-t border-line">
            {roots.data.map((root) => (
              <FolderRow key={root.id} root={root} />
            ))}
          </ul>
        ) : roots.data ? (
          <p className="text-muted">No folders yet.</p>
        ) : null}
      </div>
    </>
  );
}
