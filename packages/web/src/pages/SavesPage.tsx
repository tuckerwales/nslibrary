import type { SaveBackup, SaveOrigin } from "@nslib/shared";
import { type FormEvent, useId, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { saveDownloadUrl, useDeleteSaveBackup, useSaveBackups, useUpdateSaveBackup } from "../api";
import { Button } from "../components/Button";
import { ConfirmPanel } from "../components/ConfirmPanel";
import { ErrorText, LoadError, Loading } from "../components/Feedback";
import { inputClass } from "../components/Field";
import { PageHeader } from "../components/PageHeader";
import { RelativeTime } from "../components/RelativeTime";
import { TitleIcon } from "../components/TitleIcon";
import { formatBytes, plural } from "../format";

const ORIGIN_LABEL: Record<SaveOrigin, string | null> = {
  manual: null,
  auto: "Automatic",
  "pre-restore": "Before a restore",
};

export interface SaveGroup {
  key: string;
  /** "Player on Living room", or "Device save on Living room". */
  label: string;
  backups: SaveBackup[];
}

export interface GameSaves {
  applicationId: string;
  name: string;
  iconUrl: string | null;
  inLibrary: boolean;
  saves: SaveGroup[];
}

/**
 * Groups backups by game, then by save: one user's account save, or the device save, on one
 * console. Games with the most recent backup come first; the list from the server is newest first.
 */
export function groupSaves(backups: SaveBackup[]): GameSaves[] {
  const games = new Map<string, GameSaves>();
  for (const backup of backups) {
    let game = games.get(backup.applicationId);
    if (!game) {
      game = {
        applicationId: backup.applicationId,
        name: backup.name,
        iconUrl: backup.iconUrl,
        inLibrary: backup.inLibrary,
        saves: [],
      };
      games.set(backup.applicationId, game);
    }
    const key = [backup.type, backup.userId ?? "", backup.deviceId ?? backup.deviceName].join(":");
    let save = game.saves.find((s) => s.key === key);
    if (!save) {
      const who = backup.type === "device" ? "Device save" : (backup.userName ?? "Unnamed user");
      save = { key, label: `${who} on ${backup.deviceName}`, backups: [] };
      game.saves.push(save);
    }
    save.backups.push(backup);
  }
  return [...games.values()];
}

function NoteForm({ backup, onDone }: { backup: SaveBackup; onDone: () => void }) {
  const update = useUpdateSaveBackup();
  const id = useId();
  const [note, setNote] = useState(backup.note ?? "");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate({ id: backup.id, note: note.trim() || null }, { onSuccess: onDone });
  };
  return (
    <form onSubmit={submit} className="mt-2 max-w-md">
      <label htmlFor={id} className="block text-sm font-semibold">
        Note
      </label>
      <div className="mt-1.5 flex gap-2">
        <input
          id={id}
          value={note}
          maxLength={200}
          placeholder="Before the final boss"
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onDone();
          }}
          className={inputClass}
        />
        <Button type="submit" disabled={update.isPending}>
          Save
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <ErrorText>{update.error?.message}</ErrorText>
    </form>
  );
}

function BackupRow({ backup, title }: { backup: SaveBackup; title: string }) {
  const update = useUpdateSaveBackup();
  const remove = useDeleteSaveBackup();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const origin = ORIGIN_LABEL[backup.origin];
  const when = new Date(backup.createdAt).toLocaleString();

  return (
    <li className="border-b border-line py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="font-semibold semi-condensed">
            <RelativeTime timestamp={backup.createdAt} />
            {backup.pinned && <span className="ml-2 text-sm text-accent">Pinned</span>}
            {origin && <span className="ml-2 text-sm font-normal text-muted">{origin}</span>}
          </p>
          <p className="text-sm text-muted">
            {plural(backup.fileCount, "file")} · {formatBytes(backup.dataSize)}
          </p>
          {backup.note && !editing && <p className="mt-1 text-sm">{backup.note}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <a
            href={saveDownloadUrl(backup.id)}
            download
            aria-label={`Download the ${title} backup from ${when}`}
            className="inline-flex h-8 items-center rounded-md px-2 text-sm font-semibold text-muted hover:text-ink"
          >
            Download
          </a>
          <Button
            variant="ghost"
            className="h-8 px-2"
            aria-label={`${backup.pinned ? "Unpin" : "Pin"} the ${title} backup from ${when}`}
            disabled={update.isPending}
            onClick={() => update.mutate({ id: backup.id, pinned: !backup.pinned })}
          >
            {backup.pinned ? "Unpin" : "Pin"}
          </Button>
          <Button
            variant="ghost"
            className="h-8 px-2"
            aria-label={`${backup.note ? "Edit the note on" : "Add a note to"} the ${title} backup from ${when}`}
            onClick={() => setEditing(true)}
          >
            {backup.note ? "Edit note" : "Add note"}
          </Button>
          <Button
            variant="ghost"
            className="h-8 px-2"
            aria-label={`Delete the ${title} backup from ${when}`}
            onClick={() => setConfirming(true)}
          >
            Delete
          </Button>
        </div>
      </div>
      {editing && <NoteForm backup={backup} onDone={() => setEditing(false)} />}
      {confirming && (
        <ConfirmPanel
          label="Delete this backup?"
          confirmLabel="Delete backup"
          busy={remove.isPending}
          onConfirm={() => remove.mutate(backup.id, { onSuccess: () => setConfirming(false) })}
          onCancel={() => setConfirming(false)}
        >
          <p>
            The backup from {when} is removed from the server. The save on the console is not
            touched.
          </p>
          <ErrorText>{remove.error?.message}</ErrorText>
        </ConfirmPanel>
      )}
      <ErrorText>{update.error?.message}</ErrorText>
    </li>
  );
}

export function SavesPage() {
  const saves = useSaveBackups();
  const [params, setParams] = useSearchParams();
  const app = params.get("app")?.toUpperCase() ?? null;
  const [query, setQuery] = useState("");
  const games = useMemo(() => groupSaves(saves.data ?? []), [saves.data]);
  const needle = query.trim().toLowerCase();
  const shown = games.filter(
    (game) =>
      (!app || game.applicationId === app) &&
      (!needle ||
        game.name.toLowerCase().includes(needle) ||
        game.applicationId.toLowerCase().includes(needle)),
  );
  const filteredGame = app ? games.find((game) => game.applicationId === app) : undefined;

  return (
    <>
      <PageHeader title="Saves">
        <p>
          Save data backed up from your Switch. Back up and restore saves from the Saves tab of the
          NSLibrary app on the console; downloads are tar archives any archive tool opens.
        </p>
      </PageHeader>

      {saves.error ? (
        <LoadError error={saves.error} />
      ) : !saves.data ? (
        <Loading />
      ) : games.length === 0 ? (
        <p className="max-w-[65ch] text-muted">
          No backups yet. Open the Saves tab in the NSLibrary app on a paired Switch and choose{" "}
          <strong>Back up</strong> on a game, or back up every save at once.
        </p>
      ) : (
        <>
          {app ? (
            <p className="mb-4 text-muted">
              Showing {filteredGame?.name ?? app}.{" "}
              <Button
                variant="ghost"
                className="h-auto px-0 text-accent hover:underline"
                onClick={() => setParams({})}
              >
                Show every game
              </Button>
            </p>
          ) : (
            <div className="mb-6 max-w-sm">
              <label htmlFor="saves-search" className="sr-only">
                Search saves
              </label>
              <input
                id="saves-search"
                type="search"
                placeholder="Search saves"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className={inputClass}
              />
            </div>
          )}
          {shown.length === 0 && <p className="text-muted">No saves match.</p>}
          {shown.map((game) => (
            <section key={game.applicationId} className="mb-10">
              <div className="flex items-center gap-3">
                <TitleIcon name={game.name} seed={game.applicationId} url={game.iconUrl} />
                <div className="min-w-0">
                  <h2 className="truncate text-xl">
                    {game.inLibrary ? (
                      <Link to={`/apps/${game.applicationId}`} className="hover:underline">
                        {game.name}
                      </Link>
                    ) : (
                      game.name
                    )}
                  </h2>
                  <p className="text-sm text-muted">
                    {game.name === game.applicationId
                      ? "Not in your library"
                      : game.inLibrary
                        ? game.applicationId
                        : `${game.applicationId}, not in your library`}
                  </p>
                </div>
              </div>
              {game.saves.map((save) => (
                <div key={save.key} className="mt-4">
                  <h3 className="text-lg semi-condensed">{save.label}</h3>
                  <ul className="mt-1 border-t border-line">
                    {save.backups.map((backup) => (
                      <BackupRow key={backup.id} backup={backup} title={game.name} />
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ))}
        </>
      )}
    </>
  );
}
