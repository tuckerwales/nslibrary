# NSLibrary — Switch game library + on-console installer

## Context
You want one self-hosted place to manage your own Switch dumps (base games, updates, DLC, homebrew): scan folders, get metadata, spot missing or duplicate content, and install titles on a modded Switch. The Switch side is a homebrew app that connects to the library over LAN or USB and streams installs straight into the console's content storage, without copying the whole file to the SD card first.

**What it covers:** only files you already have. There are no download sources, no shop scraping, and no title keys handed out. Keys (`prod.keys`) come from your own console, stay on the server, and are optional.

**Your decisions:**
- **Library:** Node/TypeScript server with a React web UI. It runs in Docker, and the same server is wrapped in Electron for desktop use.
- **Transport:** LAN HTTP plus USB.
- **Formats:** NSP, NSZ, XCI, XCZ.
- **Switch app:** C++ with libnx and Borealis (the xfangfang fork).

**Defaults I picked** (all changeable later):
- One admin account.
- The Switch can browse the full catalog as well as receive queued installs.
- When a title exists as both NSP and NSZ, prefer NSZ. This is a setting.
- A USB-connected Switch is trusted automatically. A setting can require pairing instead.
- The NSP forwarder waits until M8.


## Status (September 2026)

This plan was written before the build started. Milestones M0–M8 are built; this section records where the code differs from the plan and what is still open. The rest of the document is the original plan.

**Differs from the plan**
- **Verify** runs in an in-process queue, one file at a time, with streaming NCZ decoding (`VerifyService`), not a piscina worker pool.
- **Icons** are stored as read from NACP/NRO. There is no `sharp` resizing.
- **titledb** is applied when the library is read (`library/titledb-join.ts`), not copied into `applications`.
- **Catalog sync:** `GET /catalog?since` answers "no changes" or a full listing (`full: true`, empty `del`). The Switch client always fetches the full catalog, so there is no delta.
- **Switch client:** installs and event polling run on the UI thread (`wait=0` polls), after crashes with worker threads.

**Not built yet**
- Desktop installers: `electron-builder` packages `src/main.ts` as-is, which needs `tsx`, so the main process needs bundling before NSIS/dmg/AppImage builds work. Releases publish the `.nro` and the Docker image only.
- Moving Switch network and install work off the UI thread.

**Verification not recorded here:** the on-hardware checks in §8 (cancel at 10/50/90%, applet memory with a max-window NSZ, USB unplug mid-NCA, SD full). Automated coverage is the Vitest suites, the device-sim contract tests, and the host-native `switch/tests`.

---

## 1. Architecture

```
[Switch .nro] ─HTTP (LAN)─┐                         ┌─ React web UI (browser / Electron window) — REST + WebSocket
  ITransport  ─USB frames─┼─> @nslib/server ────────┤
                          │   DeviceApiService      └─ SQLite (drizzle) · scanner/watcher · keys · icon cache
                          └─ usb-host (in the server process: Electron, or Docker on a Linux host with passthrough)
```

**Core rule: the Switch always sends the requests.** "Send to Switch" puts a job in a queue, and the Switch picks it up with a long-poll. HTTP and USB therefore carry the same request/response messages and share one `DeviceApiService` behind two thin adapters.

### Repo layout (pnpm workspaces)
```
packages/
  shared/      zod schemas (web + device API), error codes, USB frame constants, title-ID utils, golden/ protocol files
  formats/     pure TS parsers: PFS0, HFS0/XCI, NCA (XTS/CTR), CNMT, NACP, ticket, NCZ, NRO ASET, keyset (reads through a RandomAccessReader)
  fixtures/    builders for synthetic PFS0/HFS0/NCA/NCZ, encrypted with a generated fake keyset (no copyrighted data)
  server/      Fastify: db/, scanner/, services/, api/web, api/device, discovery/, workers/ (hashing)
  usb-host/    node-usb session and framing; calls DeviceApiService directly
  web/         React + Vite + TanStack Query + React Router + Tailwind
  electron/    main process that embeds server + usb-host, tray
  device-sim/  Node CLI "fake Switch" used for contract tests (HTTP or USB loopback)
switch/        CMake project, lib/borealis (pinned submodule), source/, tests/ (host-native C++ tests on golden fixtures)
docker/        Dockerfile, compose.yml, 50-nintendo-switch.rules
docs/          device-api.md, usb-protocol.md, keys.md, windows-usb-driver.md
.github/workflows/ci.yml   (node tests, web build, multi-arch docker, devkitpro/devkita64 .nro build)
```

---

## 2. Library server

### Scanner
- **Library roots:** each root is mounted read-only; the server never writes into library folders.
- **Initial scan:** async walk for `.nsp .nsz .xci .xcz .nro`.
- **File identity:** `(root, rel_path, size, mtime)`. A file is re-parsed only when one of these changes or `parser_version` goes up.
- **Watching:** chokidar v4 with `awaitWriteFinish`. Each root has a polling option for SMB/NFS mounts, where filesystem events are unreliable.
- **Work queues:** parsing runs through `p-queue` at concurrency 4. Hashing and verification run in a `piscina` worker pool at concurrency 1.
- **Deleted files:** marked `missing_since` instead of being removed. They are purged after 30 days.

### Parsing: what needs keys
| Data | Source | Keys needed |
|---|---|---|
| Container entries | PFS0 (NSP/NSZ). XCI: `HEAD` at 0x100 or 0x1100 → root HFS0 → **secure** partition only (the `update` partition is ignored) | none |
| Title ID and key generation | plaintext `.tik` rights ID | none |
| Title ID, version, type (fallback) | filename `[0100…][v…]`; TID suffix `000` = base, `800` = update, anything else = DLC | none |
| Homebrew name and icon | NRO ASET | none |
| Real type, version, required firmware, content list with SHA-256s | CNMT inside the meta NCA | header key + key-area key |
| Name, publisher, icon, DLC base-ID range | control NCA → RomFS → `control.nacp` + icon | header/KAEK, or titlekek + ticket |
| Integrity | SHA-256 of each NCA (decompressed first if NCZ) compared with the CNMT | same as CNMT |

**Crypto:** Node `aes-128-xts` per 0x200 sector (Nintendo tweak) for NCA headers, `aes-128-ctr` for sections, `aes-128-ecb` for the key area.

**Keys:**
- Uploaded through the UI and stored at `/data/keys/prod.keys` with mode 0600.
- The API only reports which key names are present. Keys are never returned, logged, or sent to a device.
- Without keys the app runs in "filename mode" and labels that metadata as unverified.

**DLC → base mapping, in order:** NACP `AddOnContentBaseId` → titledb → heuristic (flagged as a guess).

**Titledb (optional, off by default):** you supply the URL or file. It is used only for names, descriptions, icons and latest-version numbers. Icons are resized with `sharp` to 128px JPEG for the Switch and 256px for the web UI.

### SQLite schema (better-sqlite3 + drizzle, WAL)
- **`library_roots`:** path, enabled, use_polling, last_scan_at.
- **`files`:** root, rel_path, size, mtime, format, parse_status/error, parser_version, metadata_source, sha256, verify_status, missing_since.
- **`container_entries`:** file_id, name, offset, size, kind.
- **`content_metas`:** file_id, title_id, version, type (app/patch/aoc), application_id, required_sys_version, key_gen, rights_id, install_size. One file can hold several metas.
- **`content_records`:** meta_id, nca_id, type, size, sha256, compressed.
- **`applications`:** application_id, name, publisher, description, icon_key, latest_known_version (+ source).
- **`titledb_titles` / `titledb_versions`**
- **`devices`:** uuid, name, token_hash, fw, ams, app_version, last_seen, transport, sd/nand free/total, revoked_at.
- **`pairing_codes`:** code_hash, expires_at, attempts.
- **`device_titles`:** device, storage, title_id, version, type, application_id.
- **`install_jobs`:** device, meta, file, target, position, status (queued/claimed/running/done/failed/cancelled/interrupted), bytes, bps, error. This table is also the transfer history.
- **`settings`, `admin`, `sessions`, `catalog_rev`** (monotonic counter used for incremental catalog sync).

**Derived flags:**
- Latest update missing
- Duplicate `(tid, version)` across files
- Superseded updates
- Orphan update/DLC (no base)
- Firmware too new for a device
- Not on device X
- Verify: quick (headers only) or full (NCA hashes)

---

## 3. APIs

### Web API (`/api/v1`, cookie session)
- **Auth:** setup, login, logout.
- **Roots:** CRUD, plus a scan trigger.
- **Apps:** `GET /apps?q&type&flags&device&notOnDevice&cursor`, plus `GET /apps/:id` with base, updates, DLC, files and per-device state grouped together.
- **Files:** `POST /files/:id/verify`.
- **Keys:** `PUT /keys` and `GET /keys/status`.
- **Titledb:** config and refresh.
- **Devices:** `POST /devices/pairing-code`, list, rename, revoke.
- **Jobs:** `POST /jobs {deviceId, items, target}`, reorder, cancel, list.
- **`/ws` events:** `scan.progress`, `library.changed`, `device.online/offline`, `job.updated` (throttled to 2 Hz).

### Device API (`/api/device/v1`, Bearer token)
| Endpoint | Purpose |
|---|---|
| `POST /pair` | 6-digit code shown in the web UI, valid 5 minutes, at most 5 tries → 32-byte token (only its SHA-256 is stored) |
| `GET /hello` | server ID, protocol version, `catalogRev`, capabilities |
| `PUT /state` | firmware, AMS version, free space, full installed-titles snapshot |
| `GET /catalog?since&cursor&limit` | compact, incremental catalog (short keys) |
| `GET /icons/:appId?v=` | 128px JPEG, immutable, cached on the SD card |
| `GET /files/:fileId` | Range → 206, ETag, If-Range, 1 MiB read stream |
| `GET /events?cursor&wait=25` | long-poll: `job.queued`, `job.cancel`, `catalog` |
| `POST /jobs`, `/jobs/:id/claim`, `/progress` (≤1 Hz), `/complete` | job lifecycle; installs started on the Switch also land in history |

- **Errors:** `{error:{code,msg}}`, with the same codes over USB.
- **Discovery:** the Switch sends a UDP broadcast `NSLIB?1` to port 8466 and the server replies unicast. The server also advertises mDNS `_nslibrary._tcp`. You can always enter an IP by hand; it is saved to `sdmc:/config/nslibrary/config.json`.
- **Security:**
  - Web UI: admin login. Put a reverse proxy in front for TLS if it is exposed beyond the LAN.
  - Device tokens: revocable, and each one only covers reading the catalog and that device's own jobs.
  - Electron: the main process sets a local auto-login cookie.

---

## 4. USB transport
- **Roles:** the Switch is the USB device, via libnx `usbComms` (057E:3000, vendor class, bulk IN/OUT). The host uses `node-usb`.
- **Framing:** a 32-byte little-endian header: `NSLU` magic, proto version, kind (REQ/RESP/CANCEL/PING/PONG), flags, request ID, status, `json_len`, `payload_len` (u64). It is followed by HTTP-like JSON `{m,p,h}` and a binary payload.
- **Streaming:** one exchange at a time (the Switch side holds a mutex). Payloads are streamed in 1 MiB chunks with exact-length reads, plus a ZLP when a write lands on a packet boundary.
- **Session:**
  - It starts with `POST /usb/hello`, and the device is trusted automatically unless the setting says otherwise.
  - The Switch pings every 5 s; 15 s of silence or a detach marks running jobs `interrupted`.
- **Host drivers:**
  - Windows: WinUSB via Zadig (libusbK also works). Electron detects `LIBUSB_ERROR_NOT_SUPPORTED` and shows the guide.
  - Linux: udev rule.
  - macOS: nothing needed.
- **Docker:** passthrough works only on a Linux host, via `/dev/bus/usb` plus `device_cgroup_rules: ["c 189:* rmw"]`. On Mac or Windows, use Electron for USB.
- **Hardening (M8):** switch the Switch side to raw `usbDs` endpoints with timeouts, so transfers can be cancelled.

---

## 5. Switch homebrew (C++, libnx, Borealis, CMake)
**Portlibs:** `switch-curl`, `switch-mbedtls`, `switch-zstd`, plus libnx's hardware AES-CTR and SHA-256.

```
source/
  app/        bootstrap, Settings, ServiceGuard (nifm, socket, ncm, ns, es, avm, setsys, psm), AppletGuard
  transport/  ITransport { request(); stream(req, sink) } → HttpTransport (curl, keep-alive, Range resume), UsbTransport, Discovery
  api/        DeviceApiClient, EventPoller thread
  ui/         Connect, Pair (swkbd), Main TabFrame (Library · Updates · Queue · Installed · Settings), TitleDetail, Install progress; async IconCache
  install/    InstallEngine, ContainerReader, NcaSink, NczDecoder, TicketInstaller, MetaInstaller, AppRecord, Pipeline, CancelToken, Rollback
  installed/  InstalledScanner → PUT /state
  formats/    platform-neutral pfs0/hfs0/cnmt/ncz structs (also built into switch/tests)
```

### Install engine (streamed, no copy to SD)
1. **Open the container.** Read the PFS0 header. For XCI/XCZ, read the cart header → root HFS0 → secure HFS0. Sort entries into cnmt.nca, nca, ncz, tik and cert.
2. **Preflight.**
   - Target: SD, NAND, or auto.
   - Free space: `ncmContentStorageGetFreeSpaceSize` ≥ `install_size`.
   - Warn if the required firmware is newer than the console's, or if the battery is below 15% and not charging.
3. **Tickets.** Call `esImportTicket(tik, cert)`. A failure is reported with a "sigpatches may be required" hint.
4. **Meta.** Stream the cnmt NCA into a placeholder, then `ncmContentStorageGetPlaceHolderPath` → `fsOpenFileSystemWithId(ContentMeta)`. Read and parse the `.cnmt`; the console decrypts it, so the Switch needs no keys.
5. **Contents.** For each record, skipping any that `ncmContentStorageHas` already reports:
   - Create a placeholder at the original size.
   - Stream the data: a plain NCA is written as-is. For an NCZ, the first 0x4000 bytes are raw; read `NCZSECTN`, then decompress with zstd (solid, or `NCZBLOCK` block by block) and re-encrypt each section with AES-128-CTR (crypto types 3 and 4).
   - Hash with SHA-256 as it streams (on by default). The hash must match the record and the NcaId prefix.
   - Flush, then `ncmContentStorageRegister`.
6. **Content meta.** Build the header, extended header and `NcmContentInfo[]`, then call `ncmContentMetaDatabaseSet` + `Commit`.
7. **Application record.**
   - Merge with the existing records (`nsListApplicationContentMetaStatus`).
   - Delete the old record, then push the new one through a raw `serviceDispatchIn` on the ns ApplicationManager (push is cmd 16, delete is cmd 27). libnx has no wrapper for these; follow sphaira's implementation and gate by firmware with `hosversionAtLeast`. Kept isolated in `AppRecord.cpp`.
   - For patches, also call `avmPushLaunchVersion`.
8. **Rollback.** A ScopeGuard deletes every placeholder, and any contents this job registered, when anything fails or is cancelled.
9. **Finish.** Report complete, rescan installed titles (`ncmContentMetaDatabaseList` for SD and NAND, plus `nsListApplicationRecord`), then `PUT /state`.

**Pipeline:**
- Three threads: a reader (one Range GET per NCA, up to 5 resumes) → ring buffer (8×1 MiB) → a decoder (zstd + AES + SHA) → ring buffer → a writer (ncm).
- The CancelToken is checked at every handoff.

**Memory:**
- Set `ZSTD_d_windowLogMax=27` and check the frame header first.
- The budget is about 64 MB in applet mode. If a solid NSZ needs more, the install fails cleanly and tells you to launch in title-override mode.

**During install:**
- `appletSetMediaPlaybackState(true)` and CPU boost.
- In title override, also disable auto-sleep and block the HOME button.
- Enlarged socket buffers.

**Homebrew `.nro` installs:** written to `sdmc:/switch/<name>/<name>.nro.part`, then renamed.

---

## 6. Electron
- **Main process:**
  - Takes the single-instance lock.
  - Calls `startServer({dataDir: userData, host: lan ? '0.0.0.0' : '127.0.0.1', port: 8465, usb: true})`, the same factory Docker uses.
  - Loads the UI from `http://127.0.0.1:8465`.
- **Folder picker:** native `dialog.showOpenDialog` through a preload IPC bridge (with `contextIsolation`).
- **Tray:** connected devices, active job %, Open UI, Pause scanning, "Allow LAN devices", Quit. Closing the window hides it to the tray.
- **Packaging:** electron-builder rebuilds `better-sqlite3`, `usb` and `sharp`. Targets: NSIS, dmg, AppImage/deb (the deb ships the udev rule).

## 7. Docker
- **Image:** multi-stage `node:22-bookworm-slim` for amd64 and arm64. `pnpm deploy --filter @nslib/server --prod`, with the web build copied into `server/public`.
- **Runtime:**
  - Non-root with `PUID`/`PGID`.
  - Health check on `/api/health`.
  - Env: `NSLIB_PORT=8465`, `NSLIB_DISCOVERY_PORT=8466`, `NSLIB_USB`, `NSLIB_POLLING`.
- **Volumes:** `/library/<name>:ro` (any number) and `/data` (db, keys, icon cache, titledb, logs).
- **Networking:** `network_mode: host` is recommended so UDP discovery and mDNS work. Otherwise publish 8465 and enter the IP by hand.
- **USB:** Linux host only, as in §4.

---

## 8. Milestones
| # | Deliverables | Verification |
|---|---|---|
| **M0 Foundations** | workspace, TS, Biome, Vitest, CI, `shared` schemas, `fixtures` builders (fake keyset, NCZ solid and block) | CI green; fixtures round-trip through their own parsers |
| **M1 Keyless library** | PFS0/HFS0/XCI/ticket/NRO parsers, filename inference, scanner + watcher, schema/migrations, login, roots, library list | parser tests, including truncated/corrupt input; temp-dir scanner test (add/modify/delete/rename); `fastify.inject` API tests |
| **M2 Metadata with keys** | keyset, NCA crypto, CNMT, NACP and icons, TS NCZ decoder, grouping and flags, full verify, titledb import | fixtures encrypted with the test keyset; CI cross-check against `pip install nsz` output (byte-identical NCAs, matching SHA-256) |
| **M3 Device API (HTTP)** | DeviceApiService, pairing, catalog, icons, Range, events, jobs, UDP discovery, web "Send to Switch" and Devices page, **device-sim** CLI | device-sim contract suite against a real server; golden JSON snapshots; Range edge cases (suffix ranges, If-Range, 416); cancel during a long-poll |
| **M4 Switch MVP** | CMake/Borealis build, Connect/Pair/list UI, HttpTransport, NSP → SD single-thread install, tickets/meta/app record, installed scan, progress | `switch/tests` on golden fixtures; `nxlink -s` log loop; on hardware, install a self-built test NSP, launch it, then delete it in System Settings |
| **M5 Full engine** | XCI/NSZ/XCZ, 3-thread pipeline, hash verify, cancel/rollback, NAND target, preflight, sleep handling, icon grid, detail view, queue | the same title as NSP and as NSZ gives identical content IDs; cancel at 10/50/90% leaves 0 placeholders and restores free space; applet memory test with a max-window NSZ |
| **M6 USB + Electron** | frame codec (TS + C++), usb-host, UsbTransport, Electron app and tray | golden binary frames in both languages; device-sim over an in-memory duplex; Linux and Windows hardware runs; MB/s logged per transport |
| **M7 Docker + polish** | multi-arch image, compose file, Updates and "not on device" views, history, installs started from the Switch | CI `docker compose up` smoke test plus the device-sim suite against the container |
| **M8 Hardening** | usbDs timeouts, resume after interrupt, split files, NSP forwarder, i18n, auto-update, optional HTTPS | fault injection: TCP drop, USB unplug mid-NCA, SD full |

**First files to write:**
- `packages/shared/src/device-api.ts`
- `packages/formats/src/{pfs0,hfs0,nca,cnmt,ncz,keys}.ts`
- `packages/server/src/device/DeviceApiService.ts`
- `switch/source/transport/ITransport.hpp`
- `switch/source/install/{InstallEngine,NczDecoder,AppRecord}.cpp`

---

## 9. Risks
| Risk | Mitigation |
|---|---|
| The ns app-record commands aren't in libnx and may change in new firmware | isolated in `AppRecord.cpp`, gated by firmware version; track sphaira and Awoo; errors name the failing step |
| Sigpatches needed for some tickets or modified NCAs | detect it and explain; never ship or fetch patches |
| Master key or required firmware newer than the console | preflight check against the firmware the device reports |
| Switch Wi-Fi throughput (often ~5–15 MB/s) | larger socket buffers, one Range GET per NCA, USB transport, live MB/s and ETA |
| NSZ memory use (up to a 128 MB window) | check the window before starting; prefer block mode; point to title override |
| Borealis fork churn | pinned submodule; keep UI code small |
| Native modules across Electron and Docker architectures | glibc images with prebuilt binaries; CI builds per platform |
| NAS mounts without inotify | per-root polling plus periodic rescan |

**Reference implementations:**
- sphaira: yati installer, ns push, USB
- Awoo Installer
- nicoboss/nsz `docs/formats.md`
- xfangfang/borealis
- node-usb
