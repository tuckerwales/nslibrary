# NSLibrary

Self-hosted library for **your own** Nintendo Switch dumps. Scan folders of NSP, NSZ, XCI, XCZ, and homebrew NRO files, fill in metadata, spot missing or duplicate content, and send titles to a modded Switch over LAN.

There are no download sources, no shop scraping, and no title keys handed out. Keys (`prod.keys`) come from your own console, stay on the server, and are optional.

## Features

- **Library server** — Fastify + SQLite. Walks library folders (read-only), watches for changes, and groups base games, updates, DLC, and homebrew.
- **Web UI** — React app served by the same process: library, homebrew, problems, devices, folders, and settings.
- **Metadata** — Container listings and tickets need no keys. Names, icons, firmware requirements, and NCA hashes need `prod.keys` dumped from your console. Optional titledb (a URL or file you supply) fills in names and latest-version numbers only.
- **Device API** — A paired Switch browses the catalog and claims install jobs. The console always initiates; “Send to Switch” queues work for it to pick up.
- **Discovery** — UDP `NSLIB?1` on port 8466. You can always type an IP by hand.
- **USB** — A Switch plugged into the computer running NSLibrary (Electron, or Docker on Linux with device passthrough) uses the same device API inside `NSLU` frames. Transfers time out so cancel and unplug can interrupt a job.
- **Desktop app** — Electron wraps the same server: tray, native folder picker, USB, auto sign-in on this machine.
- **Demo data** — Synthetic containers and a fake keyset so the UI is usable without real dumps. No copyrighted content.

The Switch homebrew client (C++ / [Borealis](https://github.com/xfangfang/borealis)) streams NSP, NSZ, XCI, and XCZ installs into SD or NAND without copying the whole file to the SD card first. Connect over LAN HTTP or USB.

## Quick start

**Docker** (Node 22 image, `linux/amd64` and `linux/arm64`, port 8465):

```bash
docker compose up --build
```

Open [http://localhost:8465](http://localhost:8465), create the admin account, and browse the demo library. Mount your dumps read-only as `/library/games` and add that path under **Folders**.

**Without Docker** (Node ≥ 22.15, [pnpm](https://pnpm.io) 12):

```bash
pnpm install
pnpm seed
NSLIB_SEED=true \
  NSLIB_SEED_DIR="$PWD/data/demo-library" \
  NSLIB_SEED_KEYS="$PWD/data/keys/prod.keys" \
  pnpm start
```

Then `pnpm --filter @nslib/web build` so the server can serve the UI, or run `pnpm dev:web` alongside `pnpm start` / `pnpm dev:server` and use the Vite proxy on [http://localhost:5173](http://localhost:5173).

Production deploys (Coolify, volumes, `PUID`/`PGID`) are in [docs/deploy.md](docs/deploy.md).

## Repository

pnpm workspaces. Shared types live in `@nslib/shared`; parsers never write into library folders.

| Path | Package | Role |
|---|---|---|
| `packages/shared` | `@nslib/shared` | Zod schemas, error codes, USB frame constants, golden protocol files |
| `packages/formats` | `@nslib/formats` | PFS0, HFS0/XCI, NCA, CNMT, NACP, ticket, NCZ, NRO, keyset |
| `packages/fixtures` | `@nslib/fixtures` | Synthetic containers encrypted with a generated fake keyset |
| `packages/server` | `@nslib/server` | HTTP APIs, scanner, SQLite (Drizzle), keys, titledb, UDP discovery |
| `packages/web` | `@nslib/web` | React + Vite + TanStack Query UI |
| `packages/device-sim` | `@nslib/device-sim` | CLI fake Switch for the device API (`nslib-sim`) |
| `packages/usb-host` | `@nslib/usb-host` | USB frame session and node-usb attach |
| `packages/electron` | `@nslib/desktop` | Electron window, tray, USB on the desktop |
| `switch/` | — | libnx + Borealis client, host-native C++ tests |
| `docker/` | — | Image entrypoint and compose overlay |
| `docs/` | — | Device API, USB frames, keys, deploy |

## Development

```bash
pnpm install
pnpm test          # Vitest across packages
pnpm typecheck
pnpm lint
pnpm format
pnpm dev:server    # API + scanner on :8465
pnpm dev:web       # UI on :5173, proxies /api to the server
```

`nslib-sim` talks to a running server the way a Switch would:

```bash
pnpm --filter @nslib/device-sim start -- pair --code 123456
pnpm --filter @nslib/device-sim start -- hello --token <token>
```

### Switch client

Host-native tests (no devkitPro) cover PFS0, HFS0/XCI, NCZ, CNMT, tickets, JSON, the device-API codec, USB frames, and the install pipeline against the same golden files as TypeScript:

```bash
pnpm test:switch
```

The `.nro` needs [devkitPro](https://devkitpro.org) (`switch-curl`, `switch-libzstd`). From the repo root:

```bash
./scripts/build-switch.sh
```

See [docs/switch.md](docs/switch.md) for pairing, USB, `nxlink -s`, and NSP/NSZ/XCI installs to SD or NAND. Host tests need `libzstd-dev`. Desktop: `pnpm dev:desktop` (see [docs/desktop.md](docs/desktop.md)).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `NSLIB_HOST` | `0.0.0.0` | Bind address |
| `NSLIB_PORT` / `PORT` | `8465` | HTTP (web UI, `/api/v1`, `/api/device/v1`) |
| `NSLIB_DATA_DIR` | `data` | SQLite, keys, icon cache. Docker: `/data` |
| `NSLIB_WEB_DIR` | `packages/server/public` or `packages/web/dist` | Built UI; unset serves API only |
| `NSLIB_TRUST_PROXY` | off | Set `true` behind Coolify / Traefik |
| `NSLIB_POLLING` | off | Poll library folders (NFS/SMB) instead of inotify |
| `NSLIB_DISCOVERY` | on | `0` / `false` disables UDP discovery |
| `NSLIB_DISCOVERY_PORT` | `8466` | UDP port for `NSLIB?1` |
| `NSLIB_SERVER_NAME` | `NSLibrary` | Shown in hello and discovery |
| `NSLIB_SEED` | off (on in the image) | Attach the demo library on first boot if no folders exist |
| `NSLIB_SEED_DIR` / `NSLIB_SEED_KEYS` | — | Demo library path and matching fake `prod.keys` |
| `PUID` / `PGID` | `1000` | Docker user that owns `/data` |
| `NSLIB_LOG_LEVEL` | `info` | Fastify log level |
| `NSLIB_TLS_KEY` / `NSLIB_TLS_CERT` | — | PEM files for optional HTTPS (LAN without a reverse proxy) |
| `NSLIB_NRO_PATH` | `data/update/nslibrary.nro` if present | Switch app the console can update itself from (needs `update.json` and `update.json.sig` beside it) |
| `NSLIB_FORWARDER_MAIN` | `data/forwarder/main` if present | ExeFS `main` for the HOME-menu NSP |

The server never writes into library folders. Missing files are marked, then purged after 30 days.

## Keys

Upload `prod.keys` in **Settings** (or `PUT /api/v1/keys`). Stored at `<dataDir>/keys/prod.keys` with mode `0600`. The API reports which **names** are present; key material is never returned, logged, or sent to a device.

Without keys the library still lists files from containers, tickets, and filenames, and labels that metadata as unverified. Details: [docs/keys.md](docs/keys.md).

## Documentation

- [Deploy](docs/deploy.md) — Docker image, Coolify, volumes
- [Device API](docs/device-api.md) — pairing, catalog, jobs, Range downloads
- [USB protocol](docs/usb-protocol.md) — frame layout (same messages as HTTP)
- [Keys](docs/keys.md) — `prod.keys` and filename mode
- [Switch updates](docs/updates.md) — signed `.nro` updates from GitHub Releases or your library server
