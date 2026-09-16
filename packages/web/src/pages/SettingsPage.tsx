import { type FormEvent, useState } from "react";
import {
  useKeysStatus,
  usePutKeys,
  usePutSettings,
  usePutTitledb,
  useRefreshTitledb,
  useServerSettings,
  useTitledb,
} from "../api";
import { Button } from "../components/Button";
import { inputClass, Switch } from "../components/Field";
import { LoadError, PageHeader } from "../components/PageHeader";
import { relativeTime } from "../format";

export function SettingsPage() {
  const keys = useKeysStatus();
  const putKeys = usePutKeys();
  const settings = useServerSettings();
  const putSettings = usePutSettings();
  const titledb = useTitledb();
  const putTitledb = usePutTitledb();
  const refreshTitledb = useRefreshTitledb();
  const [source, setSource] = useState<string | null>(null);

  const titledbSource = source ?? titledb.data?.source ?? "";

  const onKeys = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("keys-file") as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) return;
    const contents = await file.text();
    putKeys.mutate(contents, {
      onSuccess: () => {
        if (input) input.value = "";
      },
    });
  };

  const onTitledb = (event: FormEvent) => {
    event.preventDefault();
    putTitledb.mutate(
      { source: titledbSource.trim() || null },
      { onSuccess: () => refreshTitledb.mutate() },
    );
  };

  return (
    <>
      <PageHeader title="Settings">
        <p>
          Keys dumped from your own console unlock official names, icons, and integrity checks. They
          never leave this computer and are never sent to a Switch.
        </p>
      </PageHeader>

      <section className="max-w-2xl">
        <h2 className="text-xl">Console keys</h2>
        {keys.error ? (
          <LoadError error={keys.error} />
        ) : keys.data ? (
          <p className="mt-2 text-muted">
            {keys.data.headerKey
              ? `Loaded ${keys.data.names.length} keys, including header_key.`
              : "No prod.keys yet. Dump them with Lockpick_RCM and upload the file."}
          </p>
        ) : null}

        <form onSubmit={(e) => void onKeys(e)} className="mt-4">
          <label htmlFor="keys-file" className="block text-sm font-semibold">
            prod.keys
          </label>
          <div className="mt-1.5 flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              id="keys-file"
              name="keys-file"
              type="file"
              accept=".keys,.txt,text/plain"
              required
              className="min-w-0 text-sm file:mr-3 file:rounded-md file:border file:border-line file:bg-panel file:px-3 file:py-1.5 file:text-sm file:font-semibold"
            />
            <Button type="submit" disabled={putKeys.isPending}>
              {putKeys.isPending ? "Saving…" : "Save keys"}
            </Button>
          </div>
          {putKeys.error && (
            <p role="alert" className="mt-2 text-sm text-danger">
              {putKeys.error.message}
            </p>
          )}
          {putKeys.isSuccess && (
            <p className="mt-2 text-sm text-muted">
              Saved. The library is being re-read with the new keys.
            </p>
          )}
        </form>
      </section>

      <section className="mt-12 max-w-2xl">
        <h2 className="text-xl">Installs</h2>
        <p className="mt-2 text-muted">
          When the same title exists as both NSP and NSZ, the Switch catalog prefers the compressed
          copy.
        </p>
        {settings.data && (
          <div className="mt-4">
            <Switch
              label="Prefer NSZ / XCZ"
              checked={settings.data.preferNsz}
              disabled={putSettings.isPending}
              onChange={(preferNsz) => putSettings.mutate({ preferNsz })}
            />
          </div>
        )}
      </section>

      <section className="mt-12 max-w-2xl">
        <h2 className="text-xl">Title database</h2>
        <p className="mt-2 text-muted">
          Optional. A JSON file or URL you supply, used only for names, descriptions, and the latest
          known version. NSLibrary never downloads games from it.
        </p>
        {titledb.error ? (
          <LoadError error={titledb.error} />
        ) : titledb.data ? (
          <p className="mt-2 text-sm text-muted">
            {titledb.data.titleCount.toLocaleString()} titles loaded
            {titledb.data.lastRefreshAt
              ? `, last refreshed ${relativeTime(titledb.data.lastRefreshAt)}`
              : ""}
            .
          </p>
        ) : null}

        <form onSubmit={onTitledb} className="mt-4">
          <label htmlFor="titledb-source" className="block text-sm font-semibold">
            URL or file path
          </label>
          <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
            <input
              id="titledb-source"
              className={inputClass}
              placeholder="https://example/titledb.json"
              value={titledbSource}
              onChange={(e) => setSource(e.target.value)}
            />
            <Button type="submit" disabled={putTitledb.isPending || refreshTitledb.isPending}>
              {putTitledb.isPending || refreshTitledb.isPending ? "Saving…" : "Save and refresh"}
            </Button>
          </div>
          {(putTitledb.error || refreshTitledb.error || titledb.data?.lastError) && (
            <p role="alert" className="mt-2 text-sm text-danger">
              {putTitledb.error?.message ??
                refreshTitledb.error?.message ??
                titledb.data?.lastError}
            </p>
          )}
        </form>
      </section>
    </>
  );
}
