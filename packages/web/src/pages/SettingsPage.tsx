import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import {
  useChangePassword,
  useDownloadForwarder,
  useForwarderStatus,
  useKeysStatus,
  usePutKeys,
  usePutSettings,
  useSaveTitledb,
  useServerSettings,
  useSetTitledbEnabled,
  useTitledb,
} from "../api";
import { Button } from "../components/Button";
import { ErrorText, LoadError } from "../components/Feedback";
import { Field, inputClass, Switch } from "../components/Field";
import { PageHeader } from "../components/PageHeader";
import { RelativeTime } from "../components/RelativeTime";

function KeysSection() {
  const keys = useKeysStatus();
  const putKeys = usePutKeys();
  const [fileError, setFileError] = useState<string | null>(null);

  const onKeys = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("keys-file") as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) return;
    setFileError(null);
    let contents: string;
    try {
      contents = await file.text();
    } catch {
      setFileError("That file couldn't be read. Try choosing it again.");
      return;
    }
    putKeys.mutate(contents, {
      onSuccess: () => {
        if (input) input.value = "";
      },
    });
  };

  return (
    <section className="max-w-2xl">
      <h2 className="text-xl">Console keys</h2>
      {keys.error ? (
        <LoadError error={keys.error} />
      ) : keys.data ? (
        <p className="mt-2 text-muted">
          {keys.data.demo
            ? "Using the synthetic demo keys, which only read the demo library. Upload your console's prod.keys to read your own dumps."
            : keys.data.headerKey
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
            onChange={() => putKeys.reset()}
            className="min-w-0 text-sm file:mr-3 file:rounded-md file:border file:border-line file:bg-panel file:px-3 file:py-1.5 file:text-sm file:font-semibold"
          />
          <Button type="submit" disabled={putKeys.isPending}>
            {putKeys.isPending ? "Saving…" : "Save keys"}
          </Button>
        </div>
        <ErrorText>{fileError ?? putKeys.error?.message}</ErrorText>
        <div aria-live="polite">
          {putKeys.isSuccess && (
            <p className="mt-2 text-sm text-muted">
              Saved. The library is being re-read with the new keys.
            </p>
          )}
        </div>
      </form>
    </section>
  );
}

function InstallsSection() {
  const settings = useServerSettings();
  const putSettings = usePutSettings();

  return (
    <section className="mt-12 max-w-2xl">
      <h2 className="text-xl">Installs</h2>
      <p className="mt-2 text-muted">
        When the same title exists as both NSP and NSZ, the Switch catalog prefers the compressed
        copy. The server can make NSZ copies of your NSP files on the{" "}
        <Link to="/compression" className="underline">
          Compression
        </Link>{" "}
        page.
      </p>
      {settings.error && <LoadError error={settings.error} />}
      {settings.data && (
        <div className="mt-4 space-y-4">
          <Switch
            label="Prefer NSZ / XCZ"
            checked={settings.data.preferNsz}
            disabled={putSettings.isPending}
            onChange={(preferNsz) => putSettings.mutate({ preferNsz })}
          />
          <Switch
            label="Require pairing for USB"
            hint="Off: a USB-connected Switch is trusted automatically. On: it must enter a pairing code."
            checked={settings.data.requireUsbPairing}
            disabled={putSettings.isPending}
            onChange={(requireUsbPairing) => putSettings.mutate({ requireUsbPairing })}
          />
        </div>
      )}
    </section>
  );
}

function SavesSection() {
  const settings = useServerSettings();
  const putSettings = usePutSettings();
  const [keep, setKeep] = useState<string | null>(null);
  const current = settings.data?.saveBackupsKeep;
  const value = keep ?? (current === undefined ? "" : String(current));
  const parsed = Number(value);
  const valid = value.trim() !== "" && Number.isInteger(parsed) && parsed >= 0 && parsed <= 1000;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!valid) return;
    putSettings.mutate({ saveBackupsKeep: parsed }, { onSuccess: () => setKeep(null) });
  };

  return (
    <section className="mt-12 max-w-2xl">
      <h2 className="text-xl">Save backups</h2>
      <p className="mt-2 text-muted">
        Each save keeps its newest backups; older ones are removed when a new one arrives. Pinned
        backups are always kept, on top of this number.
      </p>
      {settings.error && <LoadError error={settings.error} />}
      {settings.data && (
        <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end">
          <Field
            label="Backups to keep per save"
            hint="0 keeps every backup."
            type="number"
            inputMode="numeric"
            min={0}
            max={1000}
            step={1}
            required
            value={value}
            onChange={(event) => {
              setKeep(event.target.value);
              putSettings.reset();
            }}
            className="sm:w-56"
          />
          <Button
            type="submit"
            className="sm:mb-6"
            disabled={!valid || putSettings.isPending || parsed === current}
          >
            {putSettings.isPending ? "Saving…" : "Save"}
          </Button>
        </form>
      )}
      <ErrorText>
        {value.trim() !== "" && !valid
          ? "Enter a whole number from 0 to 1000."
          : putSettings.error?.message}
      </ErrorText>
    </section>
  );
}

function ForwarderSection() {
  const forwarder = useForwarderStatus();
  const download = useDownloadForwarder();
  const needsKeys = forwarder.data?.keys === false;

  return (
    <section className="mt-12 max-w-2xl">
      <h2 className="text-xl">HOME menu forwarder</h2>
      <p className="mt-2 text-muted">
        An NSP you can install so NSLibrary appears on the HOME menu and launches{" "}
        <code className="text-sm">sdmc:/switch/nslibrary/nslibrary.nro</code>. Needs your{" "}
        <code className="text-sm">prod.keys</code>. Sigpatches are required to install it.
      </p>
      {forwarder.data && (
        <p className="mt-2 text-sm text-muted">
          Title ID {forwarder.data.titleId}
          {forwarder.data.loader === "stub"
            ? ". The loader binary is a stub until you build the Switch forwarder target."
            : ". Using the compiled Switch loader."}
        </p>
      )}
      <div className="mt-4">
        <Button disabled={download.isPending || needsKeys} onClick={() => download.mutate({})}>
          {download.isPending ? "Building…" : "Download NSP"}
        </Button>
      </div>
      {needsKeys && <p className="mt-2 text-sm text-muted">Upload prod.keys first.</p>}
      <ErrorText>{download.error?.message}</ErrorText>
    </section>
  );
}

function TitledbSection() {
  const titledb = useTitledb();
  const save = useSaveTitledb();
  const setEnabled = useSetTitledbEnabled();
  const [source, setSource] = useState<string | null>(null);
  const titledbSource = source ?? titledb.data?.source ?? "";

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(titledbSource.trim() || null, { onSuccess: () => setSource(null) });
  };

  return (
    <section className="mt-12 max-w-2xl">
      <h2 className="text-xl">Title database</h2>
      <p className="mt-2 text-muted">
        Optional. A JSON file or URL you supply, used only for names, which game DLC belongs to, and
        the latest known version. A URL is refreshed once a day. NSLibrary never downloads games
        from it.
      </p>
      {titledb.error ? (
        <LoadError error={titledb.error} />
      ) : titledb.data ? (
        <p className="mt-2 text-sm text-muted">
          {titledb.data.titleCount.toLocaleString()} titles loaded
          {titledb.data.lastRefreshAt ? (
            <>
              , last refreshed <RelativeTime timestamp={titledb.data.lastRefreshAt} />
            </>
          ) : null}
          .
        </p>
      ) : null}
      {titledb.data && (
        <div className="mt-4">
          <Switch
            label="Use the title database"
            hint="Off keeps the downloaded data but shows only what your files and keys provide."
            checked={titledb.data.enabled}
            disabled={setEnabled.isPending}
            onChange={(enabled) => setEnabled.mutate(enabled)}
          />
        </div>
      )}

      <form onSubmit={onSubmit} className="mt-4">
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
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save and refresh"}
          </Button>
        </div>
        {save.error ? (
          <ErrorText>{save.error.message}</ErrorText>
        ) : titledb.data?.lastError ? (
          <p className="mt-2 text-sm text-danger">
            The last refresh failed: {titledb.data.lastError}
          </p>
        ) : null}
      </form>
    </section>
  );
}

function AccountSection() {
  const change = useChangePassword();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mismatch, setMismatch] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirm) {
      setMismatch(true);
      return;
    }
    change.mutate(
      { currentPassword, newPassword },
      {
        onSuccess: () => {
          setCurrentPassword("");
          setNewPassword("");
          setConfirm("");
        },
      },
    );
  };
  const edited = () => {
    setMismatch(false);
    change.reset();
  };

  return (
    <section className="mt-12 max-w-2xl">
      <h2 className="text-xl">Account</h2>
      <p className="mt-2 text-muted">
        Changing the password signs out every other browser. Forgot it? Run{" "}
        <code>reset-password</code> on the server (see the README).
      </p>
      <form className="mt-4 max-w-sm space-y-4" onSubmit={submit}>
        <Field
          label="Current password"
          type="password"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(e) => {
            setCurrentPassword(e.target.value);
            edited();
          }}
        />
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          hint="At least 8 characters."
          minLength={8}
          required
          value={newPassword}
          onChange={(e) => {
            setNewPassword(e.target.value);
            edited();
          }}
        />
        <Field
          label="Repeat new password"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => {
            setConfirm(e.target.value);
            edited();
          }}
        />
        <ErrorText>{mismatch ? "The passwords don't match." : change.error?.message}</ErrorText>
        <div aria-live="polite">
          {change.isSuccess && <p className="text-sm text-muted">Password changed.</p>}
        </div>
        <Button type="submit" disabled={change.isPending}>
          {change.isPending ? "Changing…" : "Change password"}
        </Button>
      </form>
    </section>
  );
}

export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings">
        <p>
          Keys dumped from your own console unlock official names, icons, and integrity checks. They
          never leave this computer and are never sent to a Switch.
        </p>
      </PageHeader>
      <KeysSection />
      <InstallsSection />
      <SavesSection />
      <ForwarderSection />
      <TitledbSection />
      <AccountSection />
    </>
  );
}
