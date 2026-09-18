# Architecture

How NSLibrary is put together, and why. For usage see the [README](../README.md); for the wire
formats see [device-api.md](device-api.md) and [usb-protocol.md](usb-protocol.md).

## Scope

NSLibrary manages files you already have. It has no download sources, does not scrape shops, and
hands out no title keys. `prod.keys` comes from your own console, stays on the server, and is
optional — without it the library still works from container listings, tickets, and filenames.

## Overview

```
[Switch .nro] ─HTTP (LAN)─┐                         ┌─ React web UI (browser / Electron window) — REST + WebSocket
  ITransport  ─USB frames─┼─> @nslib/server ────────┤
                          │   DeviceApiService      └─ SQLite (drizzle) · scanner/watcher · keys · icon cache
                          └─ usb-host (in the server process: Electron, or Docker on a Linux host with passthrough)
```

**The Switch always sends the requests.** "Send to Switch" queues a job; the console picks it up with
a long poll. HTTP and USB therefore carry identical request/response messages and share one
`DeviceApiService` behind two thin adapters. This is what lets the same install engine run over
either transport, and it is the constraint to preserve when adding to the device API.

### Packages

| Path | Package | Role |
|---|---|---|
| `packages/shared` | `@nslib/shared` | Zod schemas (web + device API), error codes, USB frame constants, title-ID utilities, golden protocol files |
| `packages/formats` | `@nslib/formats` | Pure parsers: PFS0, HFS0/XCI, NCA, CNMT, NACP, ticket, NCZ, NRO, keyset. Read through a `RandomAccessReader`; never write |
| `packages/fixtures` | `@nslib/fixtures` | Synthetic container builders encrypted with a generated keyset |
| `packages/server` | `@nslib/server` | Fastify, scanner, SQLite, keys, titledb, discovery |
| `packages/web` | `@nslib/web` | React + Vite + TanStack Query + Tailwind |
| `packages/usb-host` | `@nslib/usb-host` | USB framing and node-usb attach; calls `DeviceApiService` directly |
| `packages/electron` | `@nslib/desktop` | Main process embedding server + usb-host, tray |
| `packages/device-sim` | `@nslib/device-sim` | CLI "fake Switch" used for contract tests, over HTTP or an in-memory duplex |
| `switch/` | — | libnx + Borealis client, plus host-native C++ tests |

## Library server

### Scanner

- **Roots are read-only.** The server never writes into a library folder. Removing a file marks it
  `missing_since`; it is purged after 30 days.
- **File identity** is `(root, rel_path, size, mtime)`. A file is re-parsed only when one of those
  changes, or when `parser_version` goes up.
- **Watching** uses chokidar with `awaitWriteFinish`. Each root can be switched to polling for NFS
  and SMB mounts, where filesystem events are unreliable (`NSLIB_POLLING` forces it globally).
- **Parsing** runs through `p-queue` at concurrency 4.
- **Verification** runs in `VerifyService`, an in-process queue handling one file at a time, with
  streaming NCZ decode so a large title does not have to be materialised. It reports progress and can
  be cancelled.

### What needs keys

| Data | Source | Keys needed |
|---|---|---|
| Container entries | PFS0 (NSP/NSZ); XCI reads `HEAD` at 0x100 or 0x1100 → root HFS0 → **secure** partition (the `update` partition is ignored) | none |
| Title ID, key generation | plaintext `.tik` rights ID | none |
| Title ID, version, type (fallback) | filename `[0100…][v…]`; TID suffix `000` = base, `800` = update, otherwise DLC | none |
| Homebrew name and icon | NRO ASET | none |
| Real type, version, required firmware, content list with SHA-256s | CNMT inside the meta NCA | header key + key-area key |
| Name, publisher, icon, DLC base-ID range | control NCA → RomFS → `control.nacp` + icon | header/KAEK, or titlekek + ticket |
| Integrity | SHA-256 of each NCA, decompressed first if NCZ, compared against the CNMT | as CNMT |

Crypto is Node's: `aes-128-xts` per 0x200 sector with the Nintendo tweak for NCA headers,
`aes-128-ctr` for sections, `aes-128-ecb` for the key area.

Without keys the server runs in **filename mode** and labels that metadata unverified. Keys live at
`<dataDir>/keys/prod.keys`, mode `0600`. The API reports which key *names* are present and never
returns, logs, or transmits key material — including to a paired device. See [keys.md](keys.md).

**DLC → base mapping**, in order: NACP `AddOnContentBaseId`, then titledb, then a heuristic that is
flagged as a guess.

**titledb** is optional and off by default; you supply a URL or a file, refreshed daily if it is a
URL. It is applied when the library is read (`library/titledb-join.ts`) rather than copied into the
`applications` table, and contributes only names, which game a DLC belongs to, and latest-version
numbers. Icons are stored exactly as read from NACP or NRO — there is no server-side resizing.

### Storage

SQLite through better-sqlite3 and Drizzle, in WAL mode. Tables: `library_roots`, `files`,
`container_entries`, `content_metas`, `content_records`, `applications`, `homebrew`,
`titledb_titles`, `titledb_versions`, `devices`, `pairing_codes`, `device_titles`, `install_jobs`,
`settings`, `admin`, `sessions`. `install_jobs` doubles as transfer history. Migrations are generated
into `packages/server/drizzle`.

Flags derived at read time: latest update missing, duplicate `(tid, version)`, superseded update,
orphan update or DLC, firmware newer than a device, not present on a given device, and verify state
(quick — headers only, or full — NCA hashes).

## APIs

### Web API (`/api/v1`, cookie session)

Auth (setup, login, logout), roots (CRUD plus scan trigger), apps (`GET /apps?q&type&flags&device…`
and `GET /apps/:id` grouping base, updates, DLC, files and per-device state), file verification,
keys (`PUT /keys`, `GET /keys/status`), titledb config and refresh, devices (pairing code, list,
rename, revoke), and jobs (create, reorder, cancel, list).

`/ws` pushes `scan.progress`, `library.changed`, `device.online`/`offline`, and `job.updated`.

Sessions are a 32-byte random token; only its SHA-256 is stored. Cookies are `HttpOnly`,
`SameSite=Strict`, and `Secure` over HTTPS. Passwords are scrypt (N=2¹⁵, r=8, p=1) with a constant
time comparison, and a dummy hash is compared when no admin exists so failed sign-ins take the same
time either way. Failed sign-ins are rate limited per client address.

### Device API (`/api/device/v1`, bearer token)

| Endpoint | Purpose |
|---|---|
| `POST /pair` | 6-digit code from the web UI, 5 minutes, at most 5 tries, rate limited per address → 32-byte token (only its SHA-256 is stored) |
| `GET /hello` | server ID, protocol version, `catalogRev`, capabilities, `appLatest` |
| `PUT /state` | firmware, Atmosphère version, free space, installed-titles snapshot |
| `GET /catalog?since` | compact listing with short keys |
| `GET /icons/:appId` | cached JPEG, immutable |
| `GET /files/:fileId` | Range → 206, ETag, If-Range, streamed |
| `GET /events?cursor&wait` | long poll: `job.queued`, `job.cancel`, `catalog` |
| `POST /jobs`, `/jobs/:id/{claim,progress,complete}` | job lifecycle; installs started on the console also land in history |
| `GET /update`, `/update/manifest`, `/update/signature` | signed self-update, when the server has a complete set |

`GET /catalog?since` answers either "no changes" or a full listing (`full: true`, empty `del`); there
is no delta encoding, because the client always refetches the whole catalog. Errors are
`{error:{code,msg}}` with the same codes over USB.

A device token covers reading the catalog and that device's own jobs. It cannot upload files, change
settings, or read keys. Tokens are revocable.

### Discovery

The Switch broadcasts `NSLIB?1` over UDP to port 8466 and the server replies unicast; the server also
advertises mDNS `_nslibrary._tcp`, so it appears in Bonjour and Avahi browsers. Entering an IP by
hand always works, and is saved to `sdmc:/config/nslibrary/config.json`. `NSLIB_DISCOVERY=0` turns
both off.

## USB transport

The Switch is the USB device (057E:3000, vendor class, bulk IN/OUT) through raw libnx `usbDs`
endpoints with timeouts, so a transfer can be cancelled or interrupted by unplugging. The host side
is node-usb.

Frames carry a 32-byte little-endian header — `NSLU` magic, protocol version, kind
(REQ/RESP/CANCEL/PING/PONG), flags, request ID, status, `json_len`, `payload_len` — followed by
HTTP-like JSON `{m,p,h}` and a binary payload. One exchange runs at a time; the Switch holds a mutex.
Payloads stream in 1 MiB chunks with exact-length reads, plus a zero-length packet when a write lands
on a packet boundary. The codec has golden binary fixtures in both TypeScript and C++.

A session opens with `POST /usb/hello`; a USB device is trusted automatically unless the setting says
otherwise. The Switch pings every 5 seconds, and 15 seconds of silence or a detach marks running jobs
`interrupted`.

Host drivers: WinUSB via Zadig on Windows (Electron detects `LIBUSB_ERROR_NOT_SUPPORTED` and links
the guide), a udev rule on Linux, nothing on macOS. Docker passthrough works on a Linux host only,
via `/dev/bus/usb` plus `device_cgroup_rules: ["c 189:* rmw"]`; elsewhere use the desktop app.

## Switch client

C++ with libnx and [Borealis](https://github.com/xfangfang/borealis) (the xfangfang fork, a pinned
submodule), built with CMake. Portlibs: `switch-curl`, `switch-mbedtls`, `switch-zstd`, plus libnx's
hardware AES-CTR and SHA-256.

```
source/
  app/        bootstrap, Settings, ServiceGuard (nifm, socket, ncm, ns, es, avm, setsys, psm), AppletGuard
  transport/  ITransport { request(); stream(req, sink) } → HttpTransport (curl, keep-alive, Range resume), UsbTransport, Discovery
  api/        DeviceApiClient, event polling
  ui/         Connect, Pair, tabs (Library · Updates · Queue · Installed · Settings), detail, progress, async icon cache
  install/    InstallEngine, ContainerReader, NcaSink, NczDecoder, TicketInstaller, MetaInstaller, AppRecord, Pipeline, CancelToken, Rollback
  installed/  installed-title scan → PUT /state
  formats/    platform-neutral pfs0/hfs0/cnmt/ncz structs, shared with switch/tests
  update/     signed self-update: manifest, Ed25519 verify (TweetNaCl), apply
```

Network and install work currently run on the UI thread with `wait=0` polls, after crashes with
worker threads. Moving them back off the UI thread is open work.

### Install engine

Streams into content storage without staging the whole file on the SD card.

1. **Open the container** — PFS0 header, or for XCI/XCZ the cart header → root HFS0 → secure HFS0.
   Entries sort into `cnmt.nca`, `nca`, `ncz`, `tik`, `cert`.
2. **Preflight** — target (SD, NAND, auto), free space via `ncmContentStorageGetFreeSpaceSize`, and
   warnings for required firmware newer than the console or battery under 15% while not charging.
3. **Tickets** — `esImportTicket(tik, cert)`. Failure reports a "sigpatches may be required" hint.
4. **Meta** — stream the cnmt NCA into a placeholder, then `ncmContentStorageGetPlaceHolderPath` →
   `fsOpenFileSystemWithId(ContentMeta)` and parse the `.cnmt`. The console decrypts it, so the
   Switch itself needs no keys.
5. **Contents** — for each record `ncmContentStorageHas` does not already report: create a
   placeholder at full size; stream it (a plain NCA verbatim; for NCZ the first 0x4000 bytes are raw,
   then `NCZSECTN`, then zstd decompression — solid or `NCZBLOCK` block by block — and AES-128-CTR
   re-encryption of each section for crypto types 3 and 4); hash with SHA-256 as it streams and check
   against the record and the NcaId prefix; flush and `ncmContentStorageRegister`.
6. **Content meta** — build header, extended header and `NcmContentInfo[]`, then
   `ncmContentMetaDatabaseSet` and `Commit`.
7. **Application record** — merge with existing records, delete the old record, push the new one
   through a raw `serviceDispatchIn` on the ns ApplicationManager (push is command 16, delete is 27).
   libnx has no wrapper, so this is gated by `hosversionAtLeast` and kept isolated in `AppRecord.cpp`.
   Patches also call `avmPushLaunchVersion`.
8. **Rollback** — a scope guard removes every placeholder and any content this job registered when
   anything fails or is cancelled.
9. **Finish** — report, rescan installed titles, `PUT /state`.

The pipeline is a reader (one Range GET per NCA, up to 5 resumes) → an 8×1 MiB ring buffer → a
decoder (zstd + AES + SHA) → another ring buffer → a writer (ncm), with the cancel token checked at
every handoff. `ZSTD_d_windowLogMax` is 27 and the frame header is checked first: the budget in
applet mode is roughly 64 MB, so a solid NSZ needing more fails cleanly and points at title-override
mode. During an install the client sets `appletSetMediaPlaybackState(true)`, boosts the CPU, enlarges
socket buffers, and in title override also blocks sleep and the HOME button.

Homebrew `.nro` files are written to `sdmc:/switch/<name>/<name>.nro.part` and renamed.

### Self-update

One channel, two fetch paths. A release is an `.nro` and an Ed25519 signature over the exact
`update.json` bytes, checked against a public key compiled into the app; the console looks for that
release on the library server first and GitHub second, preferring the nearest copy. Neither transport
is trusted, so both are dumb pipes: TLS to GitHub is not verified, because the Switch CA store is
incomplete, and the library server could be any host on the LAN. The signature is the whole trust
model.

That is why a server-hosted `.nro` is a **mirror** rather than a channel of its own — it can only
serve builds signed with the key the app already trusts. It exists so a console with no internet, in
particular a USB-only one, can still update. Publishing your own builds means forking with your own
key and repository.

This is the most security-sensitive code in the project — see [updates.md](updates.md) and
[SECURITY.md](../SECURITY.md).

## Desktop

The Electron main process takes a single-instance lock and calls the same `createServer` factory
Docker uses, with `dataDir` in `userData` and USB enabled, then loads the UI from
`http://127.0.0.1:8465`. It binds loopback unless you opt into LAN. Folder picking is a native
dialog through a preload IPC bridge with `contextIsolation`. The tray shows connected devices and
active job progress, and closing the window hides to it. Because whoever is at the machine is the
owner, the desktop app skips the setup token and signs in automatically once an admin exists.

Packaging is not finished: `electron-builder` currently packages `src/main.ts` as-is, which needs
`tsx` at runtime, so the main process has to be bundled before NSIS/dmg/AppImage builds work.
Releases publish the `.nro` and the Docker image only.

## Docker

Multi-stage `node:22-bookworm-slim` for amd64 and arm64. The web UI is built and copied into
`server/public`, the server is bundled with esbuild so the image runs plain JavaScript, and
`pnpm deploy --prod` produces the runtime tree. The container runs non-root via `PUID`/`PGID` with
gosu, health-checks `/api/health`, and keeps the database, keys, icon cache and titledb in `/data`.
Library folders mount at `/library/<name>:ro` and are attached as roots on start.

`network_mode: host` is recommended so UDP discovery and mDNS work; otherwise publish 8465 and enter
the IP by hand. See [deploy.md](deploy.md).

## Testing

- **Vitest** across the TypeScript packages, including `fastify.inject` API tests, temp-directory
  scanner tests, and Range edge cases.
- **`switch/tests`** — host-native C++ covering PFS0, HFS0/XCI, NCZ, CNMT, tickets, JSON, the
  device-API codec, USB frames and the install pipeline. It runs without devkitPro.
- **Golden files** in `packages/shared/golden` and `switch/tests/golden` are parsed by both the
  TypeScript and C++ sides, so the two implementations cannot drift. Both are generated; nothing in
  them is derived from copyrighted material.
- **`nslib-sim`** runs the device-API contract suite against a real server over HTTP or an in-memory
  duplex, and in CI against the built container.

Not covered by CI, because it needs hardware: cancelling at 10/50/90%, applet memory with a
max-window NSZ, unplugging USB mid-NCA, and filling the SD card.

## Known constraints

| Constraint | How it is handled |
|---|---|
| The ns application-record commands are not in libnx and may change with firmware | isolated in `AppRecord.cpp`, gated by firmware version; errors name the failing step |
| Some tickets or modified NCAs need sigpatches | detected and explained; NSLibrary never ships or fetches patches |
| Master key or required firmware newer than the console | preflight against the firmware the device reports; install can clear the requirement |
| Switch Wi-Fi throughput is often 5–15 MB/s | larger socket buffers, one Range GET per NCA, USB as an alternative, live MB/s and ETA |
| NSZ decompression windows up to 128 MB | window checked before starting; block mode preferred; points at title override |
| Borealis fork churn | pinned submodule, and UI code kept small |
| Native modules across Electron and Docker architectures | glibc images with prebuilt binaries; CI builds per platform |
| NAS mounts without inotify | per-root polling plus periodic rescan |

## Prior art

NSLibrary contains no code from these projects, but they documented the formats and system calls it
depends on, and are worth reading if you work on the install engine:

- [sphaira](https://github.com/ITotalJustice/sphaira) — yati installer, ns application-record push, USB
- [Awoo Installer](https://github.com/Huntereb/Awoo-Installer)
- [DBI](https://github.com/rashevskyv/dbi) — behaviour of the firmware-requirement reset
- [nicoboss/nsz](https://github.com/nicoboss/nsz) — `docs/formats.md`, the NCZ container
- [xfangfang/borealis](https://github.com/xfangfang/borealis) — UI toolkit
- [node-usb](https://github.com/node-usb/node-usb)

Licences and attribution for everything actually linked or vendored are in
[THIRD-PARTY.md](../THIRD-PARTY.md).
