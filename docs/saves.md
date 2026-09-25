# Save backups

A paired Switch can back up its game saves to the library server and restore them later, on the
same console or another one you own. The server keeps each backup as a plain tar archive, so a save
can also be downloaded from the web UI and opened with any archive tool.

## On the Switch

The **Saves** tab lists every account save (one per user) and device save on the console, with when
this console last backed each one up.

- **Back up every save** goes through the list and uploads the saves that changed. A save whose
  archive is byte-identical to its newest backup is skipped, so running it often is cheap.
- Open a save to **Back up now**, or to see every backup of that game on the library, from any user
  or console. Choose one to **Restore** it into the save you opened.
- **Y** reloads the list.

A restore:

1. downloads the archive to `sdmc:/config/nslibrary/tmp/` and checks its SHA-256;
2. checks every entry, and that the files fit in the save on this console;
3. backs up the save as it is now, marked **Before a restore**, so the restore can be undone;
4. clears the save and writes the archive into it, committing before the game's save journal fills.

Nothing is written to the save until steps 1 to 3 have succeeded. The game has to have created its
save on this console first (start it once), and it must not be running: close it from HOME before
backing up or restoring. **B** cancels while a save is being read or downloaded; an upload or a
write always runs to the end so the USB link and the save are never left half done.

## In the web UI

**Saves** lists every backup by game, then by save (a user's account save, or the device save, on one
console), newest first. Each backup can be downloaded, pinned, given a note, or deleted. A game's page
shows how many backups it has and links to them.

**Settings → Save backups** sets how many backups each save keeps (10 by default, 0 keeps all). When a
new backup arrives, the oldest unpinned ones beyond that number are deleted. Pinned backups are
always kept, on top of the number. Lowering it applies straight away; unpinning does not delete
anything until that save's next backup.

## Storage

Archives live at `<dataDir>/saves/<application ID>/<backup ID>.tar` (in Docker, under `/data`), never
in a library folder. Uploads stream to `<dataDir>/saves/.incoming/` first and are only kept once their
SHA-256 matches what the console sent and they parse as a save archive. `NSLIB_SAVE_MAX_MB` caps the
size of one archive (1024 by default); real saves are rarely more than a few tens of MB.

## Archive format

An uncompressed POSIX ustar archive of the save's files and directories, written the same way every
time so that an unchanged save always has the same bytes and SHA-256:

- one entry per directory (`name/`, typeflag `5`) and per file (typeflag `0`), and nothing else;
- entries sorted by the byte order of their path, directories with their trailing slash;
- mode `0755` for directories and `0644` for files; uid, gid and mtime zero; no user or group names;
- a path longer than 100 bytes is split at the last `/` that fits the 155-byte prefix field, and
  paths are at most 254 bytes;
- two 512-byte zero blocks at the end.

Paths are relative, use `/`, and may not contain `.`, `..`, empty components, backslashes or NUL. On
restore, any ustar or GNU tar holding only files and directories is accepted, including archives
made with `tar -cf save.tar .` (`./` prefixes) and ones without directory entries; missing parent
directories are created.

`packages/formats/src/save-archive.ts` and `switch/source/saves/archive.cpp` implement the format.
Both are tested against `packages/shared/golden/saves/archive.tar`, built from `archive.json`
(`UPDATE_GOLDEN=1 pnpm vitest run packages/formats/test/save-archive.test.ts` rewrites it after an
intentional change).

## Device API

Advertised as the `saves` capability in `GET /hello`. The same routes work over USB.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/saves?app&latest` | Backups, newest first. `app` filters to one game; `latest=1` keeps only the newest backup of each save |
| `POST` | `/saves?app&type&user&userName&name&origin&sha256` | Upload an archive as the body (`application/x-tar`). `201` with the new backup, or `200` with `dup: true` and the existing one when the newest backup of that save has the same bytes |
| `GET` | `/saves/:id/data` | The archive. Supports `Range`, and `If-Range` with the `ETag` (the archive's SHA-256) |

A save is identified by `app` (application ID), `type` (`account` or `device`), `user` (the account
UID as 32 uppercase hex digits: `uid[0]` then `uid[1]`, only for account saves) and the console that
uploaded it. `origin` is `manual` or `pre-restore`. Errors: `SAVE_INVALID` (422) for a bad
archive or a SHA-256 mismatch, `PAYLOAD_TOO_LARGE` (413) over the size limit, `FILE_MISSING` when an
archive was removed from the data folder.

Schemas: `SaveUploadQuerySchema`, `SaveListResponseSchema` and `SaveUploadResponseSchema` in
`packages/shared/src/device-api.ts`, with golden examples in `packages/shared/golden/device-api/`.

`nslib-sim` can exercise the routes from a computer:

```bash
nslib-sim saves   --url http://localhost:8465 --token <token> [--app ID]
nslib-sim backup  --url … --token … --app 0100ABCDEF010000 --dir ./my-save [--type device]
nslib-sim restore --url … --token … --id 12 --dir ./restored
```

## Web API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/saves?app` | Every backup, with the game's name and icon from the library |
| `GET` | `/api/v1/saves/:id/download` | The archive, named `<game> - <user> - <date>.tar` |
| `PATCH` | `/api/v1/saves/:id` | `{pinned?, note?}` |
| `DELETE` | `/api/v1/saves/:id` | Delete a backup and its archive |

`saves.changed` on the event socket tells the UI to refetch.
